---
title: "Phase 3 friction list — dogfood retro input"
kind: worklog
---

# Phase 3 friction list

Every rough edge observed while running J5 Code for real, dated, one line each with where it's tracked. This is the input the phase-4 gate's retro requires.

- **2026-09-02 — plain messages to a person are invisible** (issue #44, fix in flight): all five migrated agents and one working lane sent ledger-only check-ins no human ever saw. The tool description must carry the warning, not just docs.
- **2026-09-02 — send_message rejects explicit null for advertised-nullable fields** (issue #55, fix held at lane cap): schema/validator contract mismatch; models serialize "no value" as null. Workaround: omit optional fields.
- **2026-09-02 — queued messages cross a busy thread's long turn**: two hold orders sent mid-turn were committed durably but only processed after the lane's long PR turn finished, after the lane had already asserted READY. Delivery is honest but sequencing around long turns has no visibility; the merge-surface guard (an attributed PR comment) was the effective backstop. No issue filed yet — watch for recurrence.
- **2026-09-02 — browser-capture wrapper leaks sessions across lanes on crash** (issue #61): a crashed capture binding fell through to another lane's live session — wrong app instance, wrong fixture, plausible-looking evidence. Interim rule: captures serialized fleet-wide; lanes verify their own fixture in every image before publishing.
- **2026-09-02 — an agent's runtime stalled ~40 minutes mid-turn** with no external sign except silence; from inside, the agent cannot observe its own gap. The human noticing was the detector. Mechanism unmeasured (provider retries vs hung call) — server/provider logs around the window commissioned for a read.
- **2026-09-02 — queued agent messages render as raw envelopes** (issue #62): the thread queue strip shows `[Cross-agent message from agent:j5:a2a:thread%3A…]` wire text — no sender name, no content. The timeline formats these; the queue surface never got the renderer.
- **2026-09-02 — a human send appears to jump the message queue**: with three agent messages queued on a busy thread, Jackson's composer send was processed first. Evidence so far: the receiving thread shows an `interrupted` run at exactly that window, suggesting the composer's send-while-busy path interrupts/dispatches immediately while agent deliveries wait for idle promotion. Mechanism hypothesis, not yet confirmed from payloads; expected order was FIFO — needs a ruling once measured (bug vs. intended human-priority, and if intended, the UI should say so).
- **2026-09-02 — fleet usage pressure is real**: the Architecture agent hit its provider session limit mid-commission (resets 1:10am); transient failed runs on two other threads in the same window. Migration doubled the Fable population sharing one subscription (Traycer originals + J5 copies + lanes). The stall-log commission is parked until reset.
- **2026-09-02 — thread titles double as roster display names**: migrated agents' carrier titles ("Thread Title Request", "Ready State Confirmation") leak into list_participants until manually renamed. Cosmetic, but the roster is the address book — worth a deliberate naming step in any agent-creation flow.
