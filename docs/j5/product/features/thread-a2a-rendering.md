---
title: "A2A in the thread view — rendering the fleet's traffic for the human reader"
kind: spec
---

# A2A in the thread view

Feature definition of record, settled 2026-08-29 with Jackson
([session rulings TA1–TA5](../../worklog/thread-a2a-session-2026-08-29.md));
TA1 amended 2026-08-31, ratified by Jackson directly while live-testing
B3's build (PR #16) — no session, amendments folded in below.
The problem: in phase-3 dogfood the human lives inside agents' threads,
and today every A2A delivery renders as a wall of envelope text — raw
participant ids, per-message protocol boilerplate, silence notices
indistinguishable from letters. The envelope is written _for the agent_;
the human should read the letter, not the postal regulations — with what
the agent actually saw one click away. Approved mockup in the design
workspace (`product/thread-a2a/`).

## The four treatments

1. **Incoming peer message** (TA1, as amended 2026-08-31): a distinct
   block — sender display name (**clickable — navigates to the sender's
   thread**; ruled into the B1/B6 scope), the exchange badge beside the
   name (**"Expects reply"** — viewer-neutral copy — / _closed your
   exchange_ / plain), time, message body. No second sub-line: the
   squadron id row is removed. **Parsed blocks carry no raw-envelope
   expander** — live use showed it duplicative, reading as debug UI. The
   renderer remains a parser over versioned envelope text, and raw text
   remains its **mandatory fallback** for unrecognized versions
   ([never-guess](../principles.md)) — that negative control is
   untouched; what changed is only that successfully parsed blocks no
   longer re-expose the envelope. _(As originally settled 2026-08-29:
   sender + Squadron sub-line, "expects your reply" copy, and a
   "show raw envelope" expander on every block — all three amended in
   Jackson's live test of the first real build.)_
2. **Human inbox reply** (TA2): rendered as the person — **"You · via
   Inbox"** for the local operator. No display names exist yet; the label
   derives from the person id (multi-human invariant, R29), so named
   humans render properly when names arrive.
3. **Silence notice** (TA3, expander clause amended 2026-08-31 with
   TA1): one muted line — "⚠ Platform notice · ⟨counterpart⟩'s turn
   ended without replying · ⟨age⟩". Parsed notices carry no expander —
   the expander removal applies to parsed blocks everywhere; unparseable
   notice text falls back to raw rendering, as everywhere.
4. **Outbound send** (TA4): a compact directional line — "→ ⟨receiver⟩ ·
   expects reply" — carrying live exchange state (_open · 2h_ /
   _✓ answered_) once the client can read it (A5); send-time static chips
   until then.

> **Dogfood v0 note:** TA2's "You" label is overridden in v0 — the merged
> auth principal carries no person binding, so v0 renders neutral
> `Via Inbox · <person>` (DV4). Overrides live in one place only:
> [`../dogfood-v0.md`](../dogfood-v0.md). This document remains the
> end-state truth; the "You" upgrade returns with the auth-subject→person
> binding session.

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
