---
title: "A1 — Epic entity + communication ledger (M1)"
kind: ticket
status: 2
---

> **Terminology note (post-E6):** the grouping concept was renamed **epic → squadron** on 2026-08-17 (definition: `product/epic/`); the code rename landed in PR #8. "Epic" below is preserved as dated historical record — read it as "squadron." Filesystem paths are literal.

<user_quoted_section>DONE 2026-08-17 — delivered by shakedown PR group d9445ab1 via PR #4, merged by Jackson as 521c50aa9 (reviewed head 79d60067). 5 findings fixed, 1 refuted, zero open; negative controls (deleted cursor row, corrupted membership projection) proven capable of failing. Group retired clean (prg group done, zero open asks). Retro at the Spawner's report (Director log): pre-PR liveness blind spot + watchdog outage alerting, both deferred by Jackson's call. Residual seams handed to A2/A5: runtime ledger/retry reassessment, snapshot/subscription join, receipt-rollback regression.</user_quoted_section>

# A1 — Epic entity + communication ledger

**Governing artifacts (read first):** `../../index.md` (the plan — esp. §Epic entity, §Ledger, §Base), `../../../index.md` (decision register D1–D10), `FORK.md` in the repo. Base: `j5/main` @ `e7597dac8`, clone at `/Users/jackson/repos/jacksondr5/j5code`.

## Goal

The per-epic append-only communication ledger exists, durable and queryable, plus the minimal epic entity that gives it an address. Foundation for every other A2A ticket.

## Scope

- **Minimal epic entity**: `epic` table (id, name, created_at) + create/list/read commands. NO container features (terminals/artifacts/folders/worktrees are future backlog).
- **`comm_event` table** + its own migration(s): per-epic monotonic `seq`, append-only; columns and event kinds exactly as the plan's §Ledger (incl. `message.received` for cross-epic pairing, unique constraint on receiver `(epic_id, correlation_id)` — the constraint ships here even though the writer arrives in A2).
- **New contracts file(s)** (J5-owned, e.g. `packages/contracts/src/j5/a2a.ts` or equivalent new-file location): event schemas, participant model (agents-with-threads + the one global human node; provider-native ExecutionNodes excluded per D1), branded ids (`ExchangeId`, `CorrelationId`, epic id).
- **Append command path** following the house pattern: command → durable idempotency receipt → pure decider → event + projection in one SQL transaction → ordered publish.
- **Cursor read contract**: per-epic strictly-ascending, exactly-once, gap-free relative to cursor; documented "snapshot end ≠ caught up to now" caveat.
- **Membership projection** derived from `participant.joined/left` events; rebuildable from the ledger.

## Out of scope

Delivery worker, exchanges, envelopes, tools (A2). Silence (A3). Inbox (A4). Graph API (A5). Placement/provenance (A6).

## Dependencies

None (first ticket). Blocks A2, A6.

## House rules

Add-don't-modify: new files, new tables, new migrations only — never edit v2 contracts/tables. pnpm + `vp`, never bun. Tests await milestones/receipts, never sleep. Stop-and-report on upstream surprises.

## Acceptance

Ordering/gap-free property tests (with a negative control: a deleted row must fail the gap-free test); restart persistence proven; append idempotency via receipts proven (replayed command → one row); membership projection rebuild from ledger byte-equivalent; full existing suite still green (zero-failure baseline holds).
