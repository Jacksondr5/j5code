---
title: "A8 — Envelope true-up: reply-delivery rendering, regarding linkage, time facts (R3/R10/R25)"
kind: ticket
status: 0
---

# A8 — Envelope true-up

**Governing artifacts:** design-review register R3, R10, R25 (../../product/design-review-2026-08-21.md); A2's envelope formatter (one formatter, per-channel renderings, versioned config Jackson owns). Staff against current `j5/main` head.

## Goal

The envelope layer catches up to the design-review register: reply deliveries teach sender-judged follow-up, exchanges can link to the exchange they survive, and every envelope carries measured time facts.

## Scope

1. **Reply-delivery rendering (R3):** a new per-channel rendering for delivering a closing reply to the original sender. Wording (versioned config): this reply closed the exchange entirely; if anything remains unanswered, open a NEW Exchange (optionally citing `regarding`). Closure MECHANICS are unchanged — one reply carrying the exchangeId still closes everything (merged A2 behavior stands); this is teaching-at-the-moment-of-action only.
2. **`regarding` linkage (R10):** one nullable field on Exchange OPEN only — links a follow-on Exchange to the one it survives. Not a general message-reference field. Ledger schema addition (nullable column, migration), tool schema addition on `send_message`'s open path, envelope wording mentions it where present.
3. **Time facts on every channel (R25):** the formatter stamps measured time facts into peer-message, silence-notice, human-origin, and the new reply-delivery renderings — delivered-at, elapsed-since-request, open-durations where an exchange is referenced. Facts are measured by the platform, never asserted by agents. Register caveat carried verbatim: behavioral effects (proactive time-reasoning by agents) are to be STUDIED, not assumed — no logic may depend on agents using them.

## Out of scope

Any closure-mechanics change (none is ratified). Sender-death handling (R1/R2 — ticket A9). Projection/UI rendering of `regarding` chains (A5 consumes as optional edge metadata).

## Dependencies

None hard (A2 merged). Coordinate ledger migration numbering with any in-flight A-series migration. Independent of registrar/A6 lane.

## Acceptance

Reply delivery to the sender renders the closure text with the exchange's time facts (snapshot test against versioned config); `regarding` set at open persists, round-trips through ledger reads, and appears in the open envelope; all four channels carry time facts (negative control: a hand-built envelope missing time facts must fail the formatter contract test); wording lives only in the versioned config (no literals in code paths — residue grep); baseline suite green.
