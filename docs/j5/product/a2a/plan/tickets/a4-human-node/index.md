---
title: "A4 — Human node: cross-ledger inbox, verbatim answers (M4)"
kind: ticket
status: 0
---

# A4 — Human node

**Governing artifacts:** `../../index.md` (§Human node), `../../../index.md` (grounding: human as first-class node; D2). Base: `j5/main` @ `e7597dac8`.

## Goal

Jackson is a first-class participant: agents ask him through the graph, he answers in the app, and his answer — verbatim — is the event that closes the exchange and reaches the asker.

## Scope

- **Inbox projection — cross-ledger by construction**: one global human node + per-squadron ledgers means the inbox aggregates open human-addressed exchanges across EVERY squadron ledger on the host. Do not scope it per-squadron and call it done (plan calls this out explicitly). Ranked by urgency (`blocking|soon|fyi`) then age.
- **Answer path**: the human's typed answer IS the `exchange.closed` event — captured verbatim, durable, linkable by id, delivered to the asker via the A2 pipeline. No manual "mark answered" step, no relay, no paraphrase.
- **Human→agent sends** use the human-origin envelope (states plainly that the human is not watching that chat and sees only what returns on this exchange).
- **Surface scope**: a _minimal functional surface_ sufficient to prove the loop end to end (a plain inbox list + answer box in the app, or dev-grade equivalent). The polished attention pane is item 4's — do not gold-plate.
- Human silence emits NO notices (unanswered count/age are item-4 dashboard metrics).

## Out of scope

Attention-pane UI/UX (item 4). Notifications/badging. Any human-silence machinery.

## Dependencies

**A2** (exchanges + delivery + envelopes). Parallel with A3/A5 is fine.

## Acceptance

End-to-end in the dev app: agent opens an exchange to the human with intent + urgency → inbox row appears (from a _different_ squadron than at least one other inbox row, proving cross-ledger aggregation) → human answers → exchange closes → asker receives the exact text (byte-equal assertion). Unanswered items never expire silently (negative control: an old item must still be present and ranked). Baseline suite green.
