---
title: "A4 — Human node: person-scoped inbox, verbatim answers (M4)"
kind: ticket
status: 0
---

# A4 — Human node

> **Amended 2026-08-23 (pre-staffing, register-reviewed):** reconciled against design-review register R5/R9/R29 and approved by the design-review authority. Supersedes conflicting older text.
>
> 1. **Person-keyed, never singleton (R9/R29):** participant model uses person-scoped nodes keyed by durable person ids (`human:<person-id>`) — never "one global human node." Inbox projection, answer path, and envelopes are person-scoped; envelopes name the person. The server factually has one person today — build no exactly-one-human assumption, and no broadcast/all-users target either (Shared-Squadrons-later; simple-tools).
> 2. **Inbox purity (R5):** the inbox contains ONLY open Exchanges deliberately addressed to a person — nothing else. No merging of stall escalations / awaiting-input observability into the attention queue (that surface is item 4's; the older communication-graph idea of merging is superseded).
> 3. Base SHA is whatever `j5/main` resolves to at staffing. "Cross-ledger" reads as "cross-Squadron, per person."

**Governing artifacts:** `../../product/a2a/plan.md` (§Human node; grounding: human as first-class node; D2), design-review register R5/R9/R29 (`../../product/design-review-2026-08-21.md`).

## Goal

Each person is a first-class participant: agents ask a person through the graph, the person answers in the app, and that answer — verbatim — is the event that closes the exchange and reaches the asker.

## Scope

- **Inbox projection — cross-Squadron per person, by construction**: person nodes + per-Squadron ledgers means each person's inbox aggregates their open Exchanges across EVERY Squadron ledger on the host. Do not scope it per-Squadron and call it done. Ranked by urgency (`blocking|soon|fyi`) then age. Pure per R5: open person-addressed Exchanges only.
- **Answer path**: the person's typed answer IS the `exchange.closed` event — captured verbatim, durable, linkable by id, delivered to the asker via the A2 pipeline. No manual "mark answered" step, no relay, no paraphrase.
- **Human→agent sends** use the human-origin envelope (states plainly that the person is not watching that chat and sees only what returns on this exchange).
- **Surface scope**: a _minimal functional surface_ sufficient to prove the loop end to end (a plain inbox list + answer box in the app, or dev-grade equivalent). The polished attention pane is item 4's — do not gold-plate.
- Human silence emits NO notices (unanswered count/age are item-4 dashboard metrics).

## Out of scope

Attention-pane UI/UX (item 4). Notifications/badging. Any human-silence machinery. All-users broadcast delivery (Shared Squadrons).

## Dependencies

**A2** (exchanges + delivery + envelopes; merged). Registrar/A6 slice for real membership provisioning of test participants. Parallel with A9 per the Dogfood v0 plan.

## Acceptance

End-to-end in the dev app: agent opens an exchange to a person with intent + urgency → inbox row appears (from a _different_ Squadron than at least one other inbox row, proving cross-Squadron aggregation) → the person answers → exchange closes → asker receives the exact text (byte-equal assertion). Unanswered items never expire silently (negative control: an old item must still be present and ranked). No code path assumes exactly one person (schema-level check: a second person id round-trips). Baseline suite green.
