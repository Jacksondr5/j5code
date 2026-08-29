---
title: "Inbox — the human obligation queue, designed"
kind: spec
---

# Inbox

Feature definition of record for the inbox's human surface, settled
2026-08-29 with Jackson
([session rulings IB1–IB7](../../worklog/inbox-session-2026-08-29.md)).
It realizes the surface R5/R26 defined: the pure obligation queue —
letters agents deliberately sent to the human, every item blocking a
sender — and the dogfood definition's heart: asks land here, and the
verbatim answer closes the exchange. Approved mockup in the design
workspace (`product/inbox/mockups/`); decision aid, not pixel spec.
Backend contract: A4's inbox projection + idempotent `answer` API.

## Where it lives

A **bell icon with a numbered open-count badge beside the rail logo**,
opening a **main-view Inbox page** (IB2). The page starts full-width;
iterate smaller as the product matures. The inbox is **person-scoped**
(R9/R29 — never assume one human) and **not Squadron-scoped**: obligations
are global to the person; each item wears its Squadron; the rail's scope
dropdown governs the thread list only (IB7).

## The item

Sender, Squadron, **intent as the subject line**, message body, urgency,
and time-since-opened as a measured R25 fact ("open 4h"). **Urgency is
the loudest element** — blocking / soon / fyi. The list orders by urgency,
then age (IB3–IB4). Collapsed items show header + intent; expanding
reveals the body and reply box.

## Answering — two first-class flows (IB1)

1. **Quick reply in place.** The user answers from the item; the platform
   clears the ask and the reply-delivery envelope tells the agent the
   platform did so (the reply closed the exchange entirely — R3).
2. **Go to the agent.** Asks are often compressed; "Open thread →" jumps
   to the asker's thread, where the user reads context and replies as
   normal chat. Closure then comes from the sender's side: **the agent
   clears its own ask via tool** once the conversation resolved it —
   sender-judges-completeness applied to withdrawal.

> **Platform dependency:** flow 2's clear-own-ask tool (+ ledger event)
> has no build ticket yet; until it ships, in-thread-resolved asks linger
> open. Tracked with the Director.

## Lifecycle

Answered items recede into a collapsed **Answered shelf** (IB5). Dropped
asks — the sender was archived — **leave the inbox immediately** (IB6):
the archive-time warning (R1/J1–J3) is the loud moment, and a confirmed
archive means the user wants it gone. No terminal rows.

## What the inbox is not

Not a backlog (non-blocking items are Memos — R26), not an alerts feed in
v0 (the platform-alerts lane — errored agents, delivery alarms — is
post-v0 per SB7; the Fleet page carries fallen-over agents meanwhile),
not Squadron-scoped, and never a place for inferred mail or auto-promoted
stalls (R5).

## Deferred (with reasons)

- **Platform-alerts lane** (SB7's second lane) — post-v0; separate data
  model, possibly shared surface.
- **Asker's-current-state on items** — marginal for v0 and the silence
  detector records first-match facts only until A10; revisit if
  dogfooding wants it.
- **Smaller/embedded inbox forms** (popover, split pane) — after the
  full page proves the flows.
