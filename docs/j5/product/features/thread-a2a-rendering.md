---
title: "A2A in the thread view — rendering the fleet's traffic for the human reader"
kind: spec
---

# A2A in the thread view

Feature definition of record, settled 2026-08-29 with Jackson
([session rulings TA1–TA5](../../worklog/thread-a2a-session-2026-08-29.md)).
The problem: in phase-3 dogfood the human lives inside agents' threads,
and today every A2A delivery renders as a wall of envelope text — raw
participant ids, per-message protocol boilerplate, silence notices
indistinguishable from letters. The envelope is written _for the agent_;
the human should read the letter, not the postal regulations — with what
the agent actually saw one click away. Approved mockup in the design
workspace (`product/thread-a2a/`).

## The four treatments

1. **Incoming peer message** (TA1): a distinct block — sender display
   name + Squadron, exchange chip (_expects your reply_ / _closed your
   exchange_ / plain), time, message body. Envelope boilerplate lives
   behind a **"show raw envelope"** expander. The expander is not
   decoration: the renderer is a parser over versioned envelope text, and
   raw text is its mandatory fallback for unrecognized versions
   ([never-guess](../principles.md)) — the expander exposes that same
   content on demand, answering "what exactly was this agent told?"
2. **Human inbox reply** (TA2): rendered as the person — **"You · via
   Inbox"** for the local operator. No display names exist yet; the label
   derives from the person id (multi-human invariant, R29), so named
   humans render properly when names arrive.
3. **Silence notice** (TA3): one muted line — "⚠ Platform notice ·
   ⟨counterpart⟩'s turn ended without replying · ⟨age⟩" — expandable to
   the full delivered text.
4. **Outbound send** (TA4): a compact directional line — "→ ⟨receiver⟩ ·
   expects reply" — carrying live exchange state (_open · 2h_ /
   _✓ answered_) once the client can read it (A5); send-time static chips
   until then.

Everything else — conversation, tool calls, work logs — keeps upstream
rendering untouched (TA5).

## Scope

v0, except live exchange chips (A5-gated). All discrimination uses
metadata already on delivered messages (`createdBy`,
`creationSource: "mcp"`, ledger message id in the thread message id) —
no text parsing for classification, and no server changes required for
the static treatments.

## What this feature is not

Not a change to what agents receive (envelope content is A8/Director
territory), not a summary layer (bodies render verbatim; the platform
composes nothing), and not an inbox: exchange chips inform, they never
demand — obligations live in [the inbox](inbox.md).
