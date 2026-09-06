# Thread-view A2A rendering session — rulings record (2026-08-29)

Jackson + UI/UX design agent; dogfood-v0 UX workstream (area 6), same-day
continuation of SB1–SB7 and IB1–IB7. Scope: how A2A traffic renders
inside an agent's thread. Ground truth established first: deliveries
arrive as ordinary thread messages whose text is the full envelope
(`envelopes.v1.json` v6, raw participant ids, per-delivery protocol
boilerplate), but carry machine-readable metadata — `createdBy`
(system/user/agent), `creationSource: "mcp"`, and a thread message id
encoding the ledger message id — so a client can discriminate A2A traffic
and join exchange state without text parsing. Mockup approved in the
design workspace (`product/thread-a2a/`). Feature doc of record:
[`../product/features/thread-a2a-rendering.md`](../product/features/thread-a2a-rendering.md).

| ID  | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TA1 | **Incoming peer messages restyle as distinct blocks**: resolved sender name + Squadron, an exchange chip (expects your reply / closed your exchange / plain message), time, then the message body only. The envelope boilerplate collapses behind a **"show raw envelope" expander** — kept because the renderer is a parser over versioned envelope text and raw text is its honest fallback (never-guess); the expander exposes what the agent was actually told, for the debugging moments. |
| TA2 | **Human inbox replies render as "You · via Inbox"** for the local operator. No display names exist (A4 mints `human:<id>` only — "do we have the user's name?" answered: no); the label derives from person id, so future named humans (Shared Squadrons, auth binding) render properly under the same rule.                                                                                                                                                                                   |
| TA3 | **Silence notices render as one muted system line** — icon + "Platform notice · ⟨counterpart⟩'s turn ended without replying · ⟨age⟩" — expandable to the full delivered text. Skimmable plumbing: you skim past ten, expand one.                                                                                                                                                                                                                                                               |
| TA4 | **Outbound sends render as compact directional lines** — "→ ⟨receiver⟩ · expects reply" — with live exchange state (open · ⟨age⟩ / ✓ answered) **when feasible**: live state needs a client ledger read that waits on A5; ship send-time static chips first, add live state when A5 lands ("build whatever's feasible at the time, leave the rest for later"). Live outbound state also largely satisfies the "asks I'm waiting on" question (area 9) in-thread.                               |
| TA5 | **This is v0 work** except the live chips. Normal conversation, tool calls, and work logs keep upstream rendering untouched.                                                                                                                                                                                                                                                                                                                                                                   |

## Handoff note

Discrimination and joining use metadata present today (`createdBy`,
`creationSource`, delivery message id); sender display names resolve via
ledger membership → thread title. Any unrecognized envelope version
renders as raw text — the same content the expander shows. Live chips are
the only A5-gated piece.
