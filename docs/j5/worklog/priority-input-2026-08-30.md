# Priority input for the v0 reorientation — Product lead, 2026-08-30

For Jackson + the Director. State: A1–A3 landed; A4/A6 PRs in flight (built pre-design/pre-substrate); dogfood UX map complete (SB/IB/TA/AR); SQ1 shrunk by DV1–DV3; substrate ruling landed.

## The v0 bar

Jackson dogfooding his real work solo, daily. v0-blocking = "he cannot run or trust the dogfood without it." Everything else is ordered behind that, not argued into it.

## Lanes, in order

**Lane 1 — finish and true-up the A-series core (server):**

1. A4 **amend-forward** with an IB-conformance pass (pure inbox: agent-sent asks only, no inferred items; two reply flows including the missing **clear-own-ask tool**, which is v0-blocking and rides A4; Answered shelf semantics; dropped-asks-leave-on-archive).
2. A6 **rework-first** against the substrate ruling (foundation delta, not surface delta — see interview answer Q4).
3. A5 graph read API — unblocks live exchange chips (TA), roster per-participant open-exchange counts, and the item-4 dashboard lane; add **per-participant lastActivity + open-exchange counts** as A5 projections.
4. A9 lifecycle-closure — carries the **pre-archive read** (v0-blocking for the AR dialog), archive waiter notices, and surfaces the open-Exchanges-vs-settle decision to Jackson with the implementation in front of him.

**Lane 2 — SQ1 creation surface (parallel UI lane):** DV-shrunk scope; includes the Squadron scope dropdown (SC3 as amended by SB3), which the rest of the UX lane depends on.

**Lane 3 — dogfood UX build (after SQ1's dropdown lands):** inbox page (IB) → thread A2A rendering (TA, static chips until A5) → archive dialog (AR, notices gated on A9) → **Fleet page last** (v0-wanted, not v0-start-blocking; required before Jackson migrates the work fleet at scale, not before day one).

**Post-v0, in order:** Roles (composer dropdown + Role Library — item 3's solo half), Memos (small, fully spec'd, ledger-adjacent), Crews (closes the deliberately-open member-spawn question against observable behavior), Playbooks (only after a Crew has run without one). Shared Squadrons stays vision. Azure hosting rides Jackson's personal timeline, not v0's.

## Blocking product question (one)

**The Peer-spawn tool surface disposition**: substrate settled the mechanics (Peer spawn = root-thread creation + Registrar + placement) but left the create_threads/t3_thread_start/delegate_task tool-surface disposition open. Product owns framing it; Jackson rules; Director disposes. I will bring Jackson the framed options within the week — it blocks the A6/tool-surface lane and nothing else.

Deferrable-with-owner: open-Exchanges-vs-settle (A9 surfaces it); member-Peer-spawn (Crews build, recorded); delegate_task hiding mechanics (Director, with the tool-surface ticket).

## Standing coordination flags

A4/A6 both claim migration id 006 (relayed to Director); the dogfood-v0.md overrides file governs all v0 scope questions — anything cut during build goes THERE, never inline in feature docs.
