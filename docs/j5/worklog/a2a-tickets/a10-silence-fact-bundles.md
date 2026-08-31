---
title: "A10 — Silence notices become fact bundles; labels move to projection (R4 amendment of A3)"
kind: ticket
status: 0
---

# A10 — Silence fact bundles

**Governing artifacts:** design-review register R4; R4 compliance audit of merged A3 (Director log, 2026-08-23 — verdict AMENDMENT REQUIRED on all three test parts, evidence at `SilenceDetector.ts:44-79, 233-333, 372-390`, `LedgerService.ts:408-411`). D6's five-state taxonomy is settled and unchanged — this ticket only moves WHERE labels live and completes the facts. Staff against current `j5/main` head.

## Goal

The durable `silence.notice` row records everything the platform measured; which single state labels it becomes disposable read-time policy, tunable without touching history.

## Scope (the audit's minimal amendment, adopted verbatim)

1. **Payload → one fact-bundle struct** (replacing the state-discriminated union): `subjectId`, `deliveryMessageId` (dedup key survives), `observedAt`; turn lifecycle fact (`runId`, terminal `runStatus`, `processing: processed|never-processed`, failure `detail` when present); explicit absence-of-closing-reply fact; `openOutbound: [...]` — EVERY open outbound exchange of the subject (`exchangeId`, `receiverId`, `createdAt`, human-inbox presence, delivery alarm status), never first-match-only.
2. **Precedence ladders move to projection**: `deriveNotice`/`dependencyNotice` logic becomes a pure read-time `factBundle → label` function in a projection/display module. Envelope rendering moves to delivery time, rendered from the bundle via that function; `STOPPED_NOTICE_INSTRUCTION` becomes envelope config, not a payload field.
3. **Versioning**: payload-version bump with dual-decode reader — legacy label-shaped rows read as-is (lossily back-filled where derivable); no table DDL change (payload is JSON in `j5_a2a_comm_event`); historical fact-incompleteness accepted as a one-time loss and documented. **Backfill obeys never-guess (design-review guard-rail): where a legacy row's facts are NOT derivable, the bundle field renders as explicitly unknown/absent — never synthesized from the stored label (a label is a conclusion; reversing it into facts is fabrication).**
4. **A5 coordination**: A5's edge-state derivation consumes the fact-bundle shape + label function (its ticket already amended to expect this).

## Out of scope

Any change to the five states themselves (D6), the detector's lifecycle-event sourcing, delivery mechanics, or the deferred states.

## Dependencies

A2/A3 merged. Coordinate with A8 (envelope true-up) on the formatter — sequence or co-staff so envelope changes don't collide; A8's time facts and this ticket's delivery-time rendering touch the same formatter surface.

## Acceptance

Same-fixture proof: a scenario with turn-ended + open human exchange + open peer exchange yields ONE notice row whose bundle contains all three facts, from which the projection derives a label — and changing the label-policy function re-labels the SAME historical row differently with zero migration (the R4 test made executable); dual-decode proven against pre-amendment rows; A3's original five scenario tests still pass end-to-end through the new path; zero-notices-for-healthy-idle negative control retained; baseline suite green.

> **Currency note (2026-08-31, reserved for dogfood):** anchors cite the A3-era SilenceDetector; re-measure all anchors at your base (the detector has survived several merges unchanged in substance, but verify). The R4 law this implements is stated in `docs/j5/product/design-review-2026-08-21.md` and the fact-bundle philosophy now also governs shipped surfaces (e.g. inbox terminal_disposition) — keep vocabularies consistent with `docs/j5/product/a2a/agent-tools.md`.
