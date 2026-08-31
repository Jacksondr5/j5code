---
title: "DQ2 — Versioned envelope role marker: ask vs closing reply"
kind: ticket
status: 0
---

# DQ2 — Envelope role marker

**Reserved for J5-native dogfood work — starter tier.** Self-contained; ratified by Jackson (2026-08-31) as the sanctioned unlock for truthful reply rendering.

## Context

Delivery envelopes carry `exchange_id` on both asks and closing replies, but nothing marks WHICH role a delivery plays. Consequences shipped as honest degradations: closing replies render with the ambient "Expects reply" badge (nothing marks them as replies), and sent-message cards cannot truthfully flip to "Reply received." The rendering side already extracts strictly (no heuristics — see `docs/j5/product/features/thread-a2a-rendering.md`, card states).

## Scope

- Add a versioned role marker (ask | closing-reply) to reply-delivery envelopes via the versioned envelope config (`apps/server/src/j5/a2a/envelopes.v1.json` + `EnvelopeFormatter`) — the same mechanism the closed-exchange variant used; study that change as the pattern.
- Dual-decode discipline: older envelopes without the marker keep rendering exactly as today (degraded-honest); never backfill or infer roles for historical deliveries (never-guess).
- Update the renderer's strict extraction to consume the marker where present: reply cards drop the "Expects reply" badge; sent cards may flip "Reply received" when the closing reply is locally visible with the marker.

## Acceptance

New ask delivery renders as today; new closing-reply delivery renders WITHOUT the expects-reply badge; a sent card flips truthfully when its marked closing reply lands in-thread; pre-marker seeded envelopes render unchanged (negative control); baseline green.
