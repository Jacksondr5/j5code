---
title: "Phase 3 friction list — dogfood retro input"
kind: worklog
---

# Phase 3 friction list

Every rough edge observed while running J5 Code for real, dated, one line each with where it's tracked. This is the input the phase-4 gate's retro requires.

- **2026-09-02 — plain messages to a person are invisible** (issue #44, fix in flight): all five migrated agents and one working lane sent ledger-only check-ins no human ever saw. The tool description must carry the warning, not just docs.
- **2026-09-02 — send_message rejects explicit null for advertised-nullable fields** (issue #55, fix held at lane cap): schema/validator contract mismatch; models serialize "no value" as null. Workaround: omit optional fields.
- **2026-09-02 — queued messages cross a busy thread's long turn**: two hold orders sent mid-turn were committed durably but only processed after the lane's long PR turn finished, after the lane had already asserted READY. Delivery is honest but sequencing around long turns has no visibility; the merge-surface guard (an attributed PR comment) was the effective backstop. No issue filed yet — watch for recurrence.
- **2026-09-02 — thread titles double as roster display names**: migrated agents' carrier titles ("Thread Title Request", "Ready State Confirmation") leak into list_participants until manually renamed. Cosmetic, but the roster is the address book — worth a deliberate naming step in any agent-creation flow.
