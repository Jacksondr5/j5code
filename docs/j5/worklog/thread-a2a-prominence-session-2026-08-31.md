# Thread-A2A prominence session — rulings record (2026-08-31)

Jackson + UI/UX design agent, commissioned by the Director from Jackson's
live test of PR #16 ("A2A messages insufficiently prominent in the
timeline"). Method: baseline + three rendered alternatives (tinted card /
state-coded rail / timeline event), then a two-pass refinement on the
adopted direction. Mockups in the design workspace
(`product/thread-a2a/prominence-alternatives/` and
`product/thread-a2a/final-treatment/`). Amends TA1/TA4 in
[`../product/features/thread-a2a-rendering.md`](../product/features/thread-a2a-rendering.md);
new rulings TA6–TA10 below.

| ID   | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TA6  | **Option A adopted, de-tinted.** Card surface matches upstream's subtle block treatment (the UI is hyper-focused on chat; everything else subtle). **Badges are the only attention-grabbing elements**: amber for open states (Expects reply / Awaiting reply), quiet green for resolved (Replied / Reply received), neutral outline chip for plain replies.                                                                                                                                                                                                                                                                                                                                                                                        |
| TA7  | **2-line chevron clamp on every A2A card body.** The established upstream chevron pattern ("Worked for 8.3s ›"), not a button; "› N more lines" collapsed, rotated when expanded. A UI limitation, never a content limitation — full text always one interaction away; raw fallback untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| TA8  | **Sent messages render in the sender's thread as cards** (new build item — today a send renders nothing). All A2A cards are **left-aligned**; only the human user's messages to the thread sit right. Direction carried by iconography + words: lucide **Send** (paper airplane) + "To ⟨name⟩" on sent, lucide **Inbox** + "From ⟨name⟩" on received; received cards get the subtle fill, sent cards are border-only.                                                                                                                                                                                                                                                                                                                               |
| TA9  | **Timestamps are time-since-sent**, measured from the delivery record (confirmed — never agent-recalled).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| TA10 | **Exchange-pair linking — no titles, no summaries, no UUIDs.** A reply's `exchange_id` deterministically pairs it with its ask; links are ledger facts. (a) Every reply card — sent or received — carries a clickable **verbatim one-line quote strip** ("↩ Replying to: '…'"). (b) Resolved badges are links: "Reply received" jumps to the reply, "Replied" jumps to this agent's reply — same-thread scroll-and-highlight. (c) Cross-thread reach stays on the clickable sender name; deep-linking to the exact counterpart message is the stretch version. **Caveat (Jackson): plan linking into all useful places, but if it becomes technically difficult the PR Group raises it to him — never overcomplicate the system just for linking.** |

## Alternatives considered (for the record)

Tinted letter card (A — adopted after de-tinting), state-coded edge rail
(B — design-agent lean, declined: A is most true to upstream), timeline
event treatment (C — declined: new idiom for the column). Jackson's
governing observation: upstream is hyper-focused on the chat; everything
else stays subtle, with only small elements (reply badges) grabbing
attention as they should.

## Build handoff

1. Restyle delta on #16's cards: subtle surface, badge states per TA6,
   chevron clamp per TA7, direction language per TA8.
2. **Sent-message cards** (TA8) — new rendering path in the sender's
   thread.
3. **Exchange-pair linking** (TA10) with the recorded caveat.
4. "Reply received" is likely derivable without A5 — the closing reply
   arrives in the same thread; pair locally by exchange id (dev's call
   per "build whatever's feasible").
