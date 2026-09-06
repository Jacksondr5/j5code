---
title: "B3 — Thread-view A2A rendering (TA1–TA5 static treatments)"
kind: ticket
status: 0
---

# B3 — Thread A2A rendering

**Governing artifacts:** `../../product/features/thread-a2a-rendering.md` (TA1–TA5, definition-of-record). Base: current `j5/main` — the gap analysis confirms all discrimination metadata (createdBy, creationSource, delivery message ids) and envelope text are already merged; the static treatments need **zero server changes**.

## Scope

- **TA1:** peer-message blocks with exchange chips + raw-envelope expander (versioned-envelope parser with raw fallback — an unparseable envelope renders raw, never hides).
- **TA2:** "You · via Inbox" attribution for human-answer deliveries.
- **TA3:** muted one-liner rendering for silence notices.
- **TA4:** outbound send lines/chips (lowest priority within the ticket; may trail).
- Sender-name resolution: degrade gracefully to participant id until the B6 client read lands; compose with it when available.

## Out of scope

Live exchange chips (A5-gated). Any server-side change. Alerts/badging.

## Seams

Thread-view rendering componentry — expect J5-owned renderer components composed at an upstream message-render seam; exact anchors to the Director before writing.

## Acceptance

In a dev thread carrying real A2A traffic (seeded via sanctioned seams): peer deliveries render as blocks with chips, expander shows the raw envelope byte-equal; a human-answer delivery shows "You · via Inbox"; a silence notice renders as a muted one-liner; a malformed/future-version envelope renders raw (negative control — never blank). UI screenshots on the PR. Baseline suite green.
