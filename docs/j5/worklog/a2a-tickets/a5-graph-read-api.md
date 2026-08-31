---
title: "A5 — Graph projection + read API (M5)"
kind: ticket
status: 0
---

# A5 — Graph projection + read API

> **Amended 2026-08-23 (pre-staffing, register-reviewed):** reconciled against design-review register and approved by the design-review authority.
>
> 1. **Person-keyed human nodes (R9/R29):** graph nodes for humans are person-scoped (`human:<person-id>`), never a singleton.
> 2. **Labels derive in the projection (R4):** edge states (`open | stalled(reason, trust) | answered | dropped`) are computed at projection time from ledger fact bundles (A3 notices + lifecycle facts) — never read from a write-time-chosen label as authoritative. Consumes A10's fact-bundle shape + label function once landed.
> 3. **`regarding` linkage (R10):** where an Exchange carries the nullable `regarding` field (ships with A8), expose it as edge metadata for survives-from chains. Optional — degrade gracefully, no dependency on A8.
> 4. Base SHA is whatever `j5/main` resolves to at staffing. Staffing is opportunistic per the Dogfood v0 plan (`../dogfood-v0.md`).

**Governing artifacts:** `../../product/a2a/plan.md` (§Graph projection + read API), `../../product/a2a/plan.md` (D1, D8; grounding §Projections). Base: historical, see amendment.

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

> **Currency note (2026-08-31, reserved for dogfood):** written before the substrate ruling and several shipped reads. Before building: `docs/j5/product/a2a/substrate.md` is current architectural truth; the placement substrate, single-target lifecycle verbs, and several bounded client reads (sender identity, open-count, thread-home batch) have SHIPPED — A5 absorbs/supersedes those shapes rather than duplicating them (their absorbable-by-A5 discipline is recorded in `docs/j5/worklog/dogfood-tickets/b6-client-reads.md`). Re-scope against what exists at your base; record absorbed-vs-new per read in the PR.
