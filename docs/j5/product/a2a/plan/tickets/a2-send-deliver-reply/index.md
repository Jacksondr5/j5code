---
kind: ticket
title: "A2 — Send/deliver/reply loop: exchanges, pipeline, envelopes, tools (M2)"
status: 0
---

# A2 — Send/deliver/reply loop

**Governing artifacts:** `../../index.md` (§Exchanges, §Message pipeline, §Envelopes, §Agent tool surface), `../../../index.md` (esp. D4, D5, D8, D9). Base: `j5/main` @ `e7597dac8`.

## GATE (first task, stop-and-report)
**Verify at the pin that the internal `ThreadManagementService` path — not just the MCP tool surface — honors `clientRequestId` dedup** (stable command/message ids, replay returns the same result without double-injection). The entire exactly-once story rests on this. If it does not hold internally, STOP and report to the Director before building further — do not work around it.

## Goal
A2A messaging works end to end between agents: log-first sends, exchange semantics, reliable delivery with exactly-once injection, cross-epic double-entry, one envelope formatter.

## Scope
- **Exchange lifecycle**: reply-expected send mints `exchangeId`; idempotent open per sender→receiver pair (second ask joins); follow-ups join; ONE reply carrying the id closes everything on it. Required intent summary at open (tool schema). `urgency: blocking|soon|fyi` on human-addressed opens (consumed in A4).
- **Send command**: validates participants, appends `message.sent` (+ `exchange.opened`) in one transaction; tool returns once durable.
- **Delivery worker** (drainable, milestone receipts): drains undelivered rows; agent recipients injected via v2 thread-send with **`clientRequestId` derived deterministically from the ledger message id** (upstream dedup IS the exactly-once guarantee; our `message.delivered` row records outcome only); human recipients get an inbox row (data only — A4 owns the projection/UI semantics). Failure → `message.delivery_failed` + backoff retries; past threshold → alarm state in projections, never silent. Startup reconciliation re-drains sent-but-not-delivered.
- **Cross-epic double-entry (D8)**: sender's ledger first; worker writes the paired **`message.received`** row (same payload, `correlation_id`, origin epic) into the receiver's ledger as part of delivery — deliberately async two-step, idempotent via the A1 unique constraint.
- **Envelope formatter**: one formatter, per-channel renderings (peer message; human-origin message with the "human is not watching this chat" statement; silence-notice channel shape ready for A3). All wording in a **versioned config file Jackson owns** — pick a simple format, document it, seed with reviewed defaults.
- **Agent tool surface**: `send_message(to, message, expect_reply?, exchange_id?, intent?, urgency?)` + `list_participants` (per-row capability booleans). Exposed via a J5 toolkit on the existing authenticated MCP server following upstream's toolkit pattern. Errors name the actual state and the next command. Envelope prompt text teaches exchange semantics at the moment of action.
- Retry/backoff parameters + alarm threshold as config with sensible defaults.

## Out of scope
Silence notices (A3 — but the notice envelope channel shape lands here). Inbox projection/ranking/answer flow (A4). Graph API (A5). Placement (A6).

## Dependencies
**A1.** Blocks A3, A4, A5.

## Acceptance
Kill the host mid-delivery → delivered exactly once after restart, **specifically covering the injected-but-unrecorded crash window**; cross-epic crash between sender-row commit and paired write → exactly one paired row after restart, sender ledger shows correct state; forced delivery failure → visible alarm; idempotent-open and one-reply-closes proven by test; negative controls (poisoned injection must fail the delivery test) demonstrated; two real agents (codex + claudeAgent) complete a live ask→reply exchange in the dev app; baseline suite green.
