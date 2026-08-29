---
title: "B6 — Small client-read endpoints (labels, names, counts)"
kind: ticket
status: 0
---

# B6 — Client reads bundle

**Governing artifacts:** design dependency map (sidebar-and-roster.md, inbox.md, thread-a2a-rendering.md consumers), gap-analysis net-new list. Deliberately NOT A5: these are small targeted reads the wave-1 UI lanes need now; A5's graph API supersedes or absorbs them later without breaking consumers.

## Scope

- **Sidebar row Squadron labels:** participant → home-Squadron (id + name) read (ledger membership exists server-side; expose a client-facing read).
- **Sender-name resolution** for TA rendering and inbox items (participant id → display identity).
- **Inbox open-count** for B1's bell badge (cheap count endpoint; poll-friendly).
- All J5-owned routes on the existing authenticated routes layer (#11's `makeRoutesLayer` pattern); read-only; no new auth surface.

## Out of scope

Per-participant last-activity and open-exchange counts (A5 scope — roster consumers, not wave-1). Pre-archive read (rides A9). Any write.

## Acceptance

Each read returns correct data against seeded multi-Squadron fixtures; unknowns render explicitly (never guessed); consumers (B1/B3 lanes) verified against the live endpoints in the dev app; routes ride the existing auth middleware (negative control: unauthenticated request refused). Baseline suite green.
