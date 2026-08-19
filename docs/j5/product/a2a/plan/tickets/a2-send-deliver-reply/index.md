---
title: "A2 — Send/deliver/reply loop: exchanges, pipeline, envelopes, tools (M2)"
kind: ticket
status: 1
---

# A2 — Send/deliver/reply loop

<user_quoted_section>PR #7 MERGED 2026-08-19 as 6e577f15 (Builder-executed under Jackson's one-off delegation; exact-head squash guard, containment clean). Ships: pipeline, exchanges, exactly-once delivery, cross-epic double-entry, envelopes (Jackson's wording), send_message/list_participants toolkit — membership provisioning intentionally absent per the E1–E5 boundary below. Remaining for status 2: the A2-owned registrar service in the coordinated follow-up slice + live re-proof. Next in sequence: squadron mechanical-rename PR, then registrar.</user_quoted_section>

**Governing artifacts:** `../../index.md` (§Exchanges, §Message pipeline, §Envelopes, §Agent tool surface), `../../../index.md` (esp. D4, D5, D8, D9). Base: `j5/main` @ `e7597dac8`.

## Squadron rename PR-group note

The squadron mechanical-rename group exposed a roster-registration friction: abbreviated reviewer id `bfcda17c` registered successfully but did not resolve the live Reviewer agent. The Reviewer’s independent `prg status --as` check caught it before its verdict and ledger write; the Sitter re-ran the idempotent registration with the full id `bfcda17c-607d-40d3-8378-6fcbd500be28`. Treat this as a positive process catch: verify every roster seat with `prg status --as <full-id>` at bring-up, rather than treating successful registration output as proof of liveness attribution.

## GATE (first task, stop-and-report)

**Verify at the pin that the internal `ThreadManagementService` path — not just the MCP tool surface — honors `clientRequestId` dedup** (stable command/message ids, replay returns the same result without double-injection). The entire exactly-once story rests on this. If it does not hold internally, STOP and report to the Director before building further — do not work around it.

## Goal

Pre-provisioned A2A messaging has a log-first send/deliver/reply pipeline: exchange semantics, reliable exactly-once injection, cross-epic double-entry, and one envelope formatter.

## Scope

### PR #7 implementation boundary (ratified E1–E5)

PR #7 ships the pipeline and agent-facing envelope wording only. It intentionally does **not** provision memberships in production and exposes no agent-invocable membership action: agents cannot create epics, join an epic, move between epics, or strand exchanges. The membership schema and `participant.joined`/`participant.left` lifecycle machinery remain for a later ratified path.

The named follow-up is a coordinated A2+A6 slice. A2 supplies an internal, non-agent-invocable immutable home-epic registration service with `registerAtCreation({ epicId, threadId, createdAt, commandId })` and `getHomeForThread(threadId)`: it accepts only an existing user-chosen epic, appends/replays one immutable `participant.joined`, returns that home idempotently, and rejects a conflicting home. It never creates/selects/moves/leaves epics. A6 consumes that service after durable registration for placement/provenance; wrapper-spawn replaces its direct ledger append with the registration service and inherits the spawner's home. The native user-created-agent integration hook is not present today and remains awaiting a Director ownership ruling; no agent should invent it. That slice also owns the executable human-run live-proof runbook and must rerun the real Codex→Claude proof through creation-time registration before A3 staffs. Epic terminology is unchanged pending E6.

- **Exchange lifecycle**: reply-expected send mints `exchangeId`; idempotent open per sender→receiver pair (second ask joins); follow-ups join; ONE reply carrying the id closes everything on it. Required intent summary at open (tool schema). `urgency: blocking|soon|fyi` on human-addressed opens (consumed in A4).
- **Send command**: validates participants, appends `message.sent` (+ `exchange.opened`) in one transaction; tool returns once durable.
- **Delivery worker** (drainable, milestone receipts): drains undelivered rows; agent recipients injected via v2 thread-send with **`clientRequestId` derived deterministically from the ledger message id** (upstream dedup IS the exactly-once guarantee; our `message.delivered` row records outcome only); human recipients get an inbox row (data only — A4 owns the projection/UI semantics). Failure → `message.delivery_failed` + backoff retries; past threshold → alarm state in projections, never silent. Startup reconciliation re-drains sent-but-not-delivered.
- **Cross-epic double-entry (D8)**: sender's ledger first; worker writes the paired **`message.received`** row (same payload, `correlation_id`, origin epic) into the receiver's ledger as part of delivery — deliberately async two-step, idempotent via the A1 unique constraint.
- **Envelope formatter**: one formatter, per-channel renderings (peer message; human-origin message with the "human is not watching this chat" statement; silence-notice channel shape ready for A3). All wording in a **versioned config file Jackson owns** — pick a simple format, document it, seed with reviewed defaults.
- **Agent tool surface**: `send_message(to, message, expect_reply?, exchange_id?, intent?, urgency?)` + `list_participants` (per-row capability booleans). Exposed via a J5 toolkit on the existing authenticated MCP server following upstream's toolkit pattern. Errors name the actual state and the next command. Envelope prompt text teaches exchange semantics at the moment of action.
- Retry/backoff parameters + alarm threshold as config with sensible defaults.

## Out of scope

Silence notices (A3 — but the notice envelope channel shape lands here). Inbox projection/ranking/answer flow (A4). Graph API (A5). Placement (A6).

For PR #7 specifically: the A2+A6 creation-time membership provisioning path and an executable live-proof runbook. No per-thread default epic, agent-facing `join_epic`, agent-created epic, or cross-epic reassignment behavior is sanctioned in this PR.

## Dependencies

**A1.** Blocks A3, A4, A5.

## Acceptance

Kill the host mid-delivery → delivered exactly once after restart, **specifically covering the injected-but-unrecorded crash window**; cross-epic crash between sender-row commit and paired write → exactly one paired row after restart, sender ledger shows correct state; forced delivery failure → visible alarm; idempotent-open and one-reply-closes proven by test; negative controls (poisoned injection must fail the delivery test) demonstrated; baseline suite green.

The two-real-agent Codex→Claude live ask→reply acceptance moves with the named A2+A6 creation-time provisioning follow-up. It must exercise that internal path before A3 staffs; the earlier proof establishes the pipeline only and must not be presented as proof of immutable-home-epic provisioning.
