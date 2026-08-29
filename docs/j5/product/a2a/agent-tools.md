---
title: "The agent tool surface — MCP verb contracts"
kind: spec
---

# Agent tool contracts (adopted 2026-08-29)

The definition of record for every verb on the J5 agent-facing MCP surface. [`substrate.md`](substrate.md)
rules _what_ is on the surface; this doc rules _what each verb is_ — and builders implement these
contracts rather than inventing them. **The description string is part of the contract**: it is the
agent-facing UX of the tool and is decided here, not at implementation time (Jackson, 2026-08-29).

## Conventions (apply to every J5 verb)

- **Naming**: snake_case verbs, snake_case parameters. (`spawn_agent`'s frozen A6 build used
  `clientRequestId` from the delegate passthrough; the rebuilt contract below corrects it.)
- **Idempotency**: every mutating verb takes required `client_request_id`; the server derives a
  stable command id from (provider session, request key), so retrying the same logical call replays
  the original result instead of double-acting.
- **Errors** (the toolsmith rule, `plan.md`): failures return `{ code, message }` where the message
  names the _actual state_ and the _next command_ — callers must never have to discover state by
  failing twice.
- **Events**: every mutation commits ledger/placement events in the same transaction as its state
  change; the return happens after the sender-side commit, and delivery/side-effects continue
  asynchronously.

---

## `send_message` — built (`j5/main`)

**Description (contract, current build):** "Durably send one message. client*request_id makes
retries of the same logical call idempotent. expect_reply=true opens or joins one
sender-to-receiver exchange and requires intent; a reply is send_message carrying exchange_id, and
one reply closes that exchange. urgency is required only when opening an exchange to the human. The
call returns after the sender ledger commit; delivery continues asynchronously." *(The shipped
string appends an interim availability caveat about wrapper-spawned homes; drop that sentence when
creation-surface registration lands.)\_

| Input               | Type              | Required                         | Meaning                                                |
| ------------------- | ----------------- | -------------------------------- | ------------------------------------------------------ |
| `to`                | ParticipantId     | yes                              | Directory-listed recipient                             |
| `message`           | string, non-empty | yes                              | Body; envelope adds sender identity/Squadron           |
| `client_request_id` | string            | no (yes for retries)             | Idempotency key                                        |
| `expect_reply`      | boolean           | no                               | Opens/joins an Exchange; requires `intent`             |
| `exchange_id`       | ExchangeId        | no                               | Marks this send as the reply that closes that Exchange |
| `intent`            | string            | with `expect_reply`              | One-line summary carried in projections                |
| `urgency`           | Urgency           | opening an Exchange to the human | Inbox priority                                         |

Result: `SendMessageResult` (message id, exchange state). Errors name the sender's membership state
(`A2ASenderNotJoinedError` family) or recipient addressability, each with the next command. Events:
message + exchange ledger events; delivery receipts follow asynchronously.

## `list_participants` — built (`j5/main`), columns extended by A6

**Description (contract):** "List reachable message recipients and the capabilities accepted by
each row. Use this before send*message instead of discovering participant state through failures."
*(Same interim-caveat note as `send_message`.)\_

No inputs. Result rows: `squadron_id`, `participant_id`, participant (kind, thread id for agents),
`can_receive_message`, `can_open_exchange`, `accepts_urgency`, plus the A6 columns: `provenance`
(`spawned-by` / `forked-from` / `unknown` / `not-applicable` for humans / `unrecorded`) and
`placement_parent_id`. Read-only; no events.

## `spawn_agent` — rebuilt contract (root-thread Peer Agent spawn; supersedes the frozen A6 build)

**Description (contract):** "Spawn one Peer Agent into the caller's Squadron. The new agent is a
full citizen: its own top-level thread, any provider, visible and addressable like any agent. It is
placed under the caller with immutable spawned-by provenance, and it inherits the caller's Squadron
— there is no placement or Squadron parameter. Spawning does not open an Exchange: to get a result,
follow up with send_message expect_reply=true to the returned participant_id. client_request_id is
required and must be reused for retries."

| Input                | Type                                 | Required | Meaning                                                                                                                          |
| -------------------- | ------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `brief`              | string, non-empty                    | yes      | The first-turn prompt the new agent starts with                                                                                  |
| `title`              | string                               | no       | Thread title; derived from the brief when omitted                                                                                |
| `provider` / `model` | ids from `orchestrator_capabilities` | no       | Default: inherit the caller's provider and model (runtime/interaction modes likewise). Roles will carry richer allowlists later. |
| `client_request_id`  | string, non-empty                    | yes      | Idempotency key                                                                                                                  |

Result: `participant_id`, `thread_id`, `squadron_id`, `placement` (parent = caller, provenance
`spawned-by`, source `j5_wrapper`). Semantics: creates an ordinary **root-lineage** thread via the
upstream creation seam (never `delegate_task`), registers the immutable Squadron home
(fail-closed: refuses before creation if the caller's home no longer names an existing Squadron),
records placement + provenance atomically, then starts the first turn with the brief. Errors:
caller-membership state (missing/ambiguous, with the `list_participants` next-command), home
integrity, creation failure — each naming state and next command. Events: `participant.joined`,
home registration, `participant.placement_created`.

## `stop_agent` / `archive_agent` — built at the frozen A6 head; contracts carry over unchanged

**Description (contract, `stop_agent`):** "Stop one J5 participant and every agent below it in the
mutable placement tree, leaves first. The caller must be a current member of squadron_id. Cascade
never follows provenance: a fork placed beside its source is not stopped with that source."
`archive_agent` is identical with archive semantics.

| Input               | Type              | Required                            |
| ------------------- | ----------------- | ----------------------------------- |
| `client_request_id` | string, non-empty | yes                                 |
| `squadron_id`       | SquadronId        | yes (must be the caller's Squadron) |
| `participant_id`    | ParticipantId     | yes (cascade root)                  |

Result: per-participant outcome rows (`interrupt_requested`, `archived`, `already_archived`, …) in
leaves-first order. Errors name the caller's actual Squadron and the corrected retry. Events:
placement cascade events; the per-thread interrupt/archive commands are upstream's own.

## `clear_own_ask` — ruled, unbuilt (inbox IB1b; substrate.md "needed-but-unbuilt")

**Description (contract):** "Withdraw your own open ask: closes the exchange you opened without
sending a reply message. Use this after the other party resolved your ask outside the exchange —
for example the human answered in your thread instead of the inbox — so the obligation does not
linger. Only the exchange's sender may clear it; a cleared exchange is closed in the ledger and
exits the recipient's inbox. client_request_id is required and must be reused for retries."

| Input               | Type              | Required                                        |
| ------------------- | ----------------- | ----------------------------------------------- |
| `exchange_id`       | ExchangeId        | yes (an exchange the caller opened, still open) |
| `client_request_id` | string, non-empty | yes                                             |

Result: the closed exchange state (id, closure kind `sender-cleared`, closed-at). Errors (each
naming state + next command): caller is not the exchange's sender; exchange already closed (idempotent
replay returns the original result instead when `client_request_id` matches); unknown exchange id.
Events: an exchange-closure ledger event distinguishable from reply-closure (`sender-cleared`), so
inbox status, exchange projections, and the eventual A5 graph render the withdrawal honestly.

---

## Kept upstream tools (via `J5OrchestratorSurface`)

- **`orchestrator_capabilities`** — handler overridden. Response contract: providers and models
  (ids, labels, option descriptors) for spawn targeting, plus runtime/interaction mode facts.
  It stops advertising `appOwnedSubagents`, `canRunChildTask`, and delegation features entirely;
  J5 verbs are advertised by their own descriptions, not by the capabilities payload.
- **`schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`** —
  consumed as-is, upstream descriptions unchanged.
- **`t3_thread_list`, `t3_thread_read`, `t3_thread_wait`** — consumed as-is (observation is
  unregulated). If upstream descriptions reference `delegate_task`, the J5 surface re-declares the
  affected tool with corrected prose.
- **`create_threads` / `t3_thread_start`** — the open row (substrate.md): drop recommended,
  undecided. If kept, their descriptions must be re-written here first — the shipped strings steer
  callers toward `delegate_task`.
