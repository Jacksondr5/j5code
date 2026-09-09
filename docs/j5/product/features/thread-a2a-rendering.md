---
title: "Agent-to-agent messages in the thread view"
kind: definition
---

# Agent-to-agent messages in the thread view

## Problem

The person lives inside agents' threads. Every message an agent receives from another agent, every silence notice, every reply that arrives through the inbox, is delivered as an envelope written _for the agent_ — participant ids, protocol instructions, the mechanics of what is owed. Read raw, a thread becomes a wall of postal regulations in which the actual letters are hard to find, and a notice is indistinguishable from a message ([problems](../problems.md): fleet observability, human attention).

The person should read the letter, not the envelope: who said what to whom, what is still waiting, and what has been answered — in plain words, at a glance, with the conversation's own rendering left alone.

## Definition

Agent-to-agent traffic in a thread is rendered as **cards** — a distinct treatment from the conversation, which keeps upstream's rendering untouched. Four kinds of item get a card.

A **received message** from another agent shows the sender's name (a link to the sender's thread), a badge for what the message asks of the reader, the time, and the body. There is no envelope on the card: the renderer reads the versioned envelope text and shows the letter. If it meets an envelope version it does not understand, it shows the raw text rather than guessing — a visible fallback, never a plausible fake.

A **reply that arrived through the inbox** is rendered as the person who sent it: "You · via Inbox" when the reader is that person, otherwise the person's name. The label comes from the person id, so it is right for any number of people.

A **silence notice** is one muted platform line — "⚠ Platform notice · ⟨counterpart⟩'s turn ended without replying · ⟨age⟩" — visibly not a letter from anyone.

A **sent message** is a card in the sender's own thread, the same shape as a received card, showing the receiver and whether the message still waits for a reply.

Cards are quiet. Received cards carry the app's faint block fill, sent cards are border-only, and **badges are the only colorful elements**: amber for something still waiting, quiet green for something resolved. All A2A cards sit on the left; only the person's own messages sit on the right. Long bodies clamp to a couple of lines with the app's usual "more lines" affordance — a display limit, never a content limit. Times are time-since-sent, from the delivery record.

Every badge uses **one vocabulary, in plain words**, on every surface that shows an Exchange: a message that wants something says **Expects reply** (received) or **Awaiting reply** (sent); a closed Exchange says **Replied**; a plain message shows no badge at all, because it demands nothing and the platform never asserts a role it did not measure. The mechanics — "the platform closed this exchange" — stay in the agent-facing envelope, where an agent needs them; a reader never sees them.

Cards **link across an Exchange**: a reply card carries a clickable verbatim quote of the ask it answers, and a resolved badge links to its paired message in the same thread. Reaching another thread is the sender's name. There are no generated titles, summaries, or ids — bodies render verbatim, and the platform composes nothing.

This is **not** a change to what agents receive, **not** a summary layer, and **not** an inbox: a badge informs, it never demands; obligations live in the [inbox](inbox.md).

## Acceptance criteria

### Received messages

1. A message from another agent renders as a card with the sender's name, a badge reflecting only the measured Exchange role, the time since it was sent, and the body; the sender's name navigates to the sender's thread.
2. A card never shows the envelope; a message whose envelope version the renderer does not recognize renders as its raw text.
3. A plain message shows no badge; a received ask shows "Expects reply"; a received message that closed an Exchange shows "Replied"; a follow-up shows "Follow-up".

### The person's replies

4. A reply that arrived through the inbox renders as the person: "You · via Inbox" for the reader who sent it, the person's name for anyone else.

### Notices

5. A silence notice renders as one muted platform line naming the counterpart and the age, visibly distinct from any message card.

### Sent messages

6. A message the agent sent renders as a border-only card in its own thread, showing the receiver and "Awaiting reply" while its Exchange is open or "Replied" once it closed; a plain send shows no badge.

### Surface and copy

7. Badges are the only colored elements on a card: amber while something waits, quiet green when resolved.
8. All A2A cards are left-aligned; only the person's own messages are right-aligned.
9. Card bodies clamp to a fixed number of lines with an expand affordance; nothing is truncated in the record.
10. No surface shows exchange-closure mechanics as reader copy; "Expects reply", "Awaiting reply", "Replied" and "Follow-up" are the only Exchange words a reader sees.

### Linking

11. A reply card, in either direction, carries a clickable verbatim quote of the ask it answers, and following it scrolls to and highlights that ask in the same thread.
12. A resolved badge links to its paired message in the same thread.

### Conversation

13. Everything that is not A2A traffic — conversation, tool calls, work logs — renders exactly as upstream renders it.

## Scenarios

- **An ask arrives.** An agent in Billing Migration receives "which schema version do we target?" from its Captain: a card with the Captain's name, an amber "Expects reply" badge, "2m", and the question. The agent replies; its thread now shows a sent card to the Captain that says "Replied" and quotes the question. (AC1, AC3, AC6, AC11)
- **The user answers from the inbox.** The user replies in the inbox; the agent's thread shows the reply as "You · via Inbox" when the user reads it, and the ask card's badge turns quiet green. (AC4, AC7, AC12)
- **A peer went quiet.** The Captain's turn ended without replying; the agent's thread shows one muted line, "Platform notice · Captain's turn ended without replying · 40m", and nothing that looks like a message. (AC5)
- **A plain update.** A peer sends a status update with no ask; the card has no badge at all. (AC3)

## History

- 2026-08-29 — the four treatments designed; former TA1–TA5 ([record](../../worklog/thread-a2a-session-2026-08-29.md)).
- 2026-08-31 — three amendments from Jackson's live test of the first build: no envelope expander on parsed cards (the raw fallback stays), no Squadron sub-line, badge copy "Expects reply", clickable sender name. Same day, the prominence session settled card anatomy, states, clamp, alignment, time and linking; former TA6–TA10 ([record](../../worklog/thread-a2a-prominence-session-2026-08-31.md)).
- 2026-09-01 — reader copy uses the "Expects reply" / "Replied" family, never closure mechanics (Jackson's final review of the inbox build).
- 2026-09-05 — "Replied" becomes the one word for a closed Exchange on every surface, replacing "Reply received" on sent cards and "Answered" on the inbox shelf (glossary).
- 2026-09-08 — rewritten into the definition shape. Former identifiers: TA1 → AC1–AC3; TA2 → AC4; TA3 → AC5; TA4, TA8 → AC6, AC8; TA5 → AC13; TA6 → AC7; TA7 → AC9; TA9 → Definition (time); TA10 → AC11–AC12. The v0 rendering of the person's inbox reply as `Via Inbox · ⟨person⟩` (the "You" claim needs a person binding the auth principal does not yet have) is build status and lives in the dogfood plan.
