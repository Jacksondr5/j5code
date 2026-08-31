---
title: "B7 — Thread A2A card treatment (TA6–TA10 final design)"
kind: ticket
status: 0
---

# B7 — Card treatment true-up

**Governing artifacts:** `../../product/features/thread-a2a-rendering.md` §Card anatomy and states (TA6–TA10; TA4 superseded by TA8), session `../thread-a2a-prominence-session-2026-08-31.md`, approved all-states mockup at design workspace `product/thread-a2a/final-treatment/` (decision aid, not pixel spec). Designer available for render questions.

## Scope

1. **Restyle delta on the shipped cards**: upstream-subtle de-tinted surface; badges are the ONLY colorful elements (amber open / quiet green resolved / neutral Reply chip); 2-line chevron clamp on card bodies ("› N more lines", upstream pattern); left-aligned cards with lucide Send + "To ⟨name⟩" vs lucide Inbox + "From ⟨name⟩"; timestamps as time-since-sent from the delivery record.
2. **Sent-message cards (TA8, net-new)**: outbound sends render as full border-only cards with Awaiting reply / Reply received badges. "Reply received" likely derivable locally (the closing reply lands in the same thread — pair by exchange id); dev's call on mechanism, truthful states only.
3. **Exchange-pair linking (TA10)**: verbatim one-line quote strip on every reply card (both directions); resolved badges as same-thread scroll-and-highlight links to the paired message; cross-thread stays on the clickable sender name; exact-message deep-link is stretch. **Jackson's caveat, verbatim force: build it where useful, but if it turns technically difficult the PR Group raises it to Jackson rather than complicating the system — no heroics for linking.**

## Constraints

All settled TA law stands (viewer-neutral copy, truthful states, raw fallback untouched, no expander on parsed cards). Composes with #23's closed-envelope semantics and the B6 sender-name read where landed; degrade honestly where not.

## Dependencies

#16 merged (base cards). Staffs when a slot frees, as a new-system group. Seam expectation: mostly J5-owned renderer files; any upstream touch via anchors to the Director.

## Acceptance

All-states render matches the approved mockup's semantics (not pixels): open/resolved/reply badge states, clamp behavior, directional iconography, sent-cards with truthful reply-state badges, quote strips and same-thread links working where built — with any TA10 piece that proved difficult raised and recorded rather than forced. Screenshots per evidence process. Baseline green.
