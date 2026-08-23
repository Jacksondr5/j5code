---
title: "A9 — Lifecycle closure: archive terminates obligations, loudly (R1/R2/R11)"
kind: ticket
status: 0
---

# A9 — Lifecycle closure

**Governing artifacts:** design-review register R1, R2, R11 (../../product/design-review-2026-08-21.md). Staff against current `j5/main` head. **Hazard note (why this is blocking-tier): archives already happen in practice and currently strand open obligations silently.**

## Goal

Retiring a participant or a Squadron terminates its open obligations as a loud, evented act — waiters are told, nothing dangles, history stays readable.

## Scope

1. **Participant archive termination (R1):** archiving a participant transitions its open Exchanges to **Dropped** with platform-authored terminal notices delivered to the affected counterparties through the normal pipeline — both dispositions: receiver-retired (waiter told: dropped, carries do-not-retry/do-not-replace) and sender-retired (the reply-owing party told the asker is gone; its obligation ends). Notices are fact bundles per R4.
2. **Squadron archive (R2):** a user-only Squadron archive operation (the Squadron entity has NO archive op today — this ticket adds it, user-only per E4 authority pattern) force-closing all open Exchanges via the R1 machinery, with visible inbox-row removal for affected humans.
3. **Active-view hiding (R11):** archived participants/Squadrons disappear from active views while their ledgers remain readable forever — no deletion, no truncation; projections gain the archived dimension.
4. **Write authority note:** this is NEW machinery, deliberately not an A3 extension — silence notices inform and never change Exchange state; archive termination is a state-transitioning write authority. Same pattern family (lifecycle fact → platform-authored ledger rows → pipeline delivery), separate service.

## Out of scope

Memos-on-archive warning (R35 — ships with the Memos feature, not here). Captain-invoked crew archive (R18–R22 — item-3 territory; this ticket's operations are user/platform-invoked only). Un-archive semantics (undesigned).

## Dependencies

A2 merged (pipeline). Sequencing with registrar/A6 lane: none hard; coordinate migration numbering.

## Acceptance

Scripted scenarios: archive a participant owing a reply → waiter receives Dropped notice with do-not-retry facts, exchange terminal in ledger and projections; archive a participant who is owed a reply → counterparty notified, obligation ended; **archive an agent holding an open Exchange addressed to a PERSON (the person owes the reply) → the person's inbox row is removed/closed visibly and evented — never left dangling, never silently vanished (R1 sender-retired disposition on the inbox surface, per design-review authority's addition)**; Squadron archive → all open Exchanges closed via R1 path, human inbox rows removed visibly (evented), ledger fully readable post-archive; negative controls: a healthy participant's exchanges must be untouched by another's archive, and an archived participant must reject new sends with a state-naming error; baseline suite green.
