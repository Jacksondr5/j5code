---
title: "Crews: /crew without a Captain persona, and one Captain with many Crews (2026-09-16)"
kind: record
---

> **Record.** How `/crew` stopped depending on a `crew-captain` saved agent, and how a Captain came to command several named Crews at once. Accurate about 2026-09-16; the current behavior is in [Crews](../product/features/crews.md).

# Crews: /crew without a Captain persona, and one Captain with many Crews

## 2026-09-16 — the command carries the guidance, not a persona

Until this session `/crew <brief>` worked only on a fresh draft: the draft launched as the saved agent with id `crew-captain`, whose instructions taught it to read the library, propose a roster, and end its turn. A library without that agent refused the command. Bryant asked to decouple the two: the command should still review the ask and file a Crew proposal for the person to decide, but through whatever agent the thread already runs as.

The `/crew` send path now wraps the brief in a short platform block (`<j5_crew_launch>`) that says only what the tools cannot: compose rather than work, end the turn after proposing, and that several Crews may run at once. The `propose_crew` and `request_crew_member` descriptions and the `<j5_crew_gate>` notice describe the rest. The thread keeps its own agent, model, and policy; any thread, fresh or mid-conversation, can become a Captain, so the fresh-draft refusal and the library check are gone and the slash menu offers `/crew` in every composer. The bundled `crew-captain` example, its built-in id, and the persona-library page's section on it were removed with the coupling rather than left as a second, drifting copy of the guidance.

## 2026-09-16 — one Captain, many Crews

Bryant also asked that a single Captain be able to run more than one Crew when the work is concurrent, and that each Crew be named and have its own expand and collapse. The server already allowed this: proposals never checked for an existing Crew, `request_crew_member` disambiguates by `crew_instance_id`, the archive cascade retires every Crew a Captain commands, and the Fleet page grouped seats per Crew. The sidebar expander did not: it folded every child under one "N crew" toggle and offered Stop only when every child belonged to one Crew.

The expander now groups a Captain's children by Crew, newest activity first, one collapsible header per Crew with the Crew's name and its state summary, plus one more group for solo Peer Agents the row spawned outside any Crew. Stop sits on the Crew header it stops. Expansion is remembered per group under its parent. The Crews definition gained a Captains bullet for concurrent Crews and a scenario with two Crews under one thread, and the `propose_crew` description tells the Captain to name each Crew for what it is for.

## 2026-09-16 — the notices become cards

With the guidance riding in the `/crew` turn, the person's own message showed the platform block in its bubble, and the Captain's thread already showed `<j5_crew_gate>` and `<j5_seat_settled>` as raw tagged text. Bryant asked to hide them unless they could be shown well. The web timeline already hands every user-role row to a J5-owned delivery renderer for A2A envelopes; the three Crew notices now ride that same seam and render as cards: the brief as the brief with the guidance one click away, the gate decision as its title, Crew name, and roster with each seat opening its thread, and seat finishes one row per seat with the run's end and the handoff's state, the handoff opening in the artifacts panel and readable inline when short. Recognition is strict, so an unparsed block stays raw, and the gate and seat notices gained the Crew's name so a Captain of several Crews reads which one each card is about. Mobile has no delivery seam and keeps showing these notices as text, as it does A2A deliveries.
