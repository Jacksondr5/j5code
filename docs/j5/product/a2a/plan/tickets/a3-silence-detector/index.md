---
kind: ticket
title: "A3 — Silence detector: five typed states (M3)"
status: 0
---

# A3 — Silence detector

**Governing artifacts:** `../../index.md` (§Silence detection), `../../../index.md` (D6; grounding §"Silence is measured; replies are asserted"). Base: `j5/main` @ `e7597dac8`.

## Goal
When an agent that owes a reply goes quiet, the waiter learns *why* — from platform-measured facts, never from anything the quiet agent was supposed to say.

## Scope
- Detector service subscribing to v2 run-lifecycle events (turn end, error, stop/cancel — hook/run-owned facts, never output parsing) joined against open exchanges and delivery events in the ledger.
- The five v1 states exactly as the plan's table: `turn-ended-no-reply` (with processed vs never-processed timestamp sub-split), `errored` (raw detail attached), `stopped/cancelled` (carries do-not-retry/do-not-replace instruction text), `awaiting-human` (human-knows vs human-doesn't-know via inbox delivery state), `blocked-on-peer` (**peer id stored structurally in the payload** — future cycle detection must need no ledger migration).
- Notices append to the ledger (`silence.notice`) and deliver to the waiter through the A2 pipeline using the silence-notice envelope channel (clearly marked system signal, never styled as a peer message).
- Notices inform; they NEVER auto-close exchanges.

## Out of scope
Deferred states (`waiting-on-external-gate`, `silent-tool-degradation`, PTY-quiet watchdog — deliberately absent, we have real events). Cycle detection (item 4). Human silence (emits nothing — D6/M4).

## Dependencies
**A2** (pipeline + envelope channels). Parallel with A4/A5 is fine.

## Acceptance
One scripted scenario per state proving the waiter receives the correct typed notice (e.g. recipient turn ends without reply → authoritative `turn-ended-no-reply`; cancelled recipient → notice carrying do-not-retry text); the processed/never-processed sub-split proven both ways; **zero notices for healthy idle agents** (negative control: a quiet-but-not-owing agent must produce nothing); notices visible in ledger reads; baseline suite green.
