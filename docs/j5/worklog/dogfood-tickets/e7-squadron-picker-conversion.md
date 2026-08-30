---
title: "E7 build — Squadron becomes the unit of user choice in every picker"
kind: ticket
status: 0
---

# E7 — Squadron picker conversion

**Governing artifacts:** `../../product/features/squadron.md` §E7 (definitional law, ruled 2026-08-31), `../picker-and-self-messaging-rulings-2026-08-31.md`, DV1/DV3 (`../../product/dogfood-v0.md`). Origin: Jackson's #20 acceptance pass — the new-thread flow still presented the upstream PROJECT picker before the prompt.

## Goal

Every context-picking surface offers **Squadrons**; "project" stops being a user-facing noun (it remains DV1 substrate — reference, never identity).

## Scope

- **Convert the new-thread flow's picker** to Squadron choice.
- **Convert the command palette** (ruled in for v0).
- **Inventory sweep**: enumerate every remaining project-picking surface in the app; convert what's in reach, board what isn't with a named disposition — no silent survivors.

## Build-critical guard (Jackson's ruling, verbatim intent — build-blocking)

Pickers key off **Squadrons (Registrar truth)**, never derived from projects — **two Squadrons over one folder must render as two distinct choices**, or DV1's acceptance criterion is silently broken in the UI. Folders render as attributes inside the flow (SC1 palette / DV3 disposition), never as a peer choice.

## Out of scope

Multi-folder (returns with its milestone). Roster/Fleet-page surfaces (own lane). Any change to the DV1 substrate model.

## Dependencies

#20 merged (Squadron creation + scope machinery). Staffs as a NEW group under the new system: agent-ops registration, `~/.pr-group` playbooks on the `personal` branch, design gate satisfied by E7's doc. Seam maps to the Director before upstream touches, as always.

## Acceptance

In the dev app: new-thread flow and command palette both offer Squadrons (never projects) as the choice; two Squadrons sharing a folder appear as two distinct entries whose selection scopes correctly (Registrar-home assertion); folder information appears only as attribute display within a Squadron context; the inventory sweep's list is recorded with per-surface disposition; no user-facing surface renders "project" as a noun. Screenshots per the evidence process. Baseline green.
