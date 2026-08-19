---
title: "A5 — Graph projection + read API (M5)"
kind: ticket
status: 0
---

# A5 — Graph projection + read API

**Governing artifacts:** `../../index.md` (§Graph projection + read API), `../../../index.md` (D1, D8; grounding §Projections). Base: `j5/main` @ `e7597dac8`.

## Goal

The communication graph exists as a queryable, subscribable projection — the data spine item 4's dashboard will render.

## Scope

- **Graph projection**: nodes = participants (incl. the human); **edges = exchanges, never messages**, state `open | stalled(reason, trust) | answered | dropped`; plus delegation edges from v2 delegations (D1 — delegations to real child threads only). Stall reason/trust comes from A3's notices.
- **Cross-squadron edges** render in each squadron's graph as external stubs joined by `correlation_id`.
- **Read API**: per-squadron cursor subscription — strictly ascending, exactly-once, gap-free relative to the cursor, documented caveat that snapshot end is a batching fact, not caught-up-to-now; plus a full-state reconciliation query (events + snapshot, never events alone).
- **Playback**: the read API can reconstruct graph state as of any past ledger sequence.
- Projection rebuild from the ledger must be **byte-equivalent** — a test, not an aspiration (measured-tables property: projections are disposable).

## Out of scope

Any UI (item 4). Cycle detection (item 4). Cross-machine subscriptions.

## Dependencies

**A2** (exchange lifecycle events; A3 enriches stall states — coordinate but don't block: stalled-state coverage can land as A3 finishes). Parallel with A3/A4 is fine.

## Acceptance

Byte-equal rebuild proven (negative control: a mutated projection row must fail the equivalence test); cursor subscription exactly-once under forced reconnect (and a deleted-row control must fail gap-free); reconciliation query matches subscription-accumulated state; playback renders a chosen historical state correctly against a scripted fixture; baseline suite green.
