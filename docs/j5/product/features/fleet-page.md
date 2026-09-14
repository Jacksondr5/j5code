---
title: "Fleet page and sidebar"
kind: definition
---

# Fleet page and sidebar

## Problem

The more agents a person runs, the less they can see. Upstream's sidebar is a recency-sorted list of conversations, which serves the agents a person is talking to and hides everything else: an agent spawned by another agent, an agent that stopped an hour ago, an agent waiting on a reply nobody knows it sent. Asking an agent how it is doing does not work either, because agents answer from context rather than measurement ([problems](../problems.md): fleet observability; human attention is scarce). The Fleet page is where the state of every agent the person is not talking to can be read.

## Definition

A person's attention splits across three surfaces, each with one job:

- The **sidebar** holds conversations in motion: the agents the person is actively talking to, sorted by recency the way upstream users expect.
- The **inbox** holds what needs the person: open asks, and nothing else ([inbox](inbox.md)).
- The **Fleet page** holds the health of everything else: every agent in a Squadron, with facts the platform measured, whether or not anyone is talking to it.

**The sidebar** is upstream's sidebar, with its mechanics for snoozing, settling and pinning untouched. J5 changes two things. The project-scope dropdown becomes the **Squadron scope**: the sidebar shows one Squadron or all of them, and agent creation takes its Squadron from that scope ([Squadron](squadron.md)). And each row speaks J5's language: the Squadron, the title, and a status label. Nothing is hidden from the sidebar by how an agent came to exist; a person who asks one agent to spawn most of the agents they talk with still finds them there. Which agents a person is expected not to talk to is a question for [Crews](crews.md), not for a filter.

**The Fleet page** is a full-width page in the main view, reached from an entry at the foot of the rail that carries a badge, and from the command palette. It shows **one Squadron at a time**. While the page is open, the sidebar is replaced by a list of every Squadron, each with its count of measured problems, and the page shows the Squadron chosen there. The choice is the page's own: it does not change the sidebar's Squadron scope, and leaving the page brings the sidebar back as it was.

The rows are the Squadron's **agents**: every registered agent participant whose home is that Squadron, arranged as the placement tree with siblings in creation order. People are never rows; they appear as counterparties in an agent's asks. Provider-native Subagents never appear; upstream's own panel is their home. Rows keep their positions. A problem marks a row; it never moves one.

Each row answers four questions, and the page's job is done when every row answers all four or says plainly that it cannot:

1. **Is it doing anything right now?** Its status, as the runtime reports it.
2. **Is anyone waiting on it, or is it waiting on anyone?** Its open asks, owed and awaited.
3. **When did it last do anything?** Its latest measured event, labeled by what the event was.
4. **Is there a measured problem?** A failed run, a delivery alarm, a run that never started.

Everything on the page is a **measurement**. There is no health score, no "stalled", no reordering by urgency, and no guess: an unknown fact renders as unknown with its reason, because a visible gap beats a plausible fake ([principles](../principles.md): never guess; status is read, never asked). Silence notices are not shown here: with several open asks a notice is ambiguous, and "ended without replying" is a judgment the person makes, so the age of the open ask carries the fact instead. The page states which environment it read and as of when. Clicking a row opens the agent's thread.

The **badge** on the rail entry counts agents with a measured problem across every Squadron the page can read, so the person learns that something is broken somewhere even while looking at one Squadron. It never counts what the inbox bell counts: the bell is where agents tell the person something, the badge is where the platform does, and one fact is counted once.

A retired agent still matters on the page when it has working descendants. Such an **orphan** keeps its parent visible as a dimmed placeholder holding its place in the tree, so the children are never re-parented and the shape of what happened stays readable. A retired agent with no active descendants is not shown.

Cost is a product surface: what a Squadron costs, and what each of its agents contributed, rolls up on this page and nowhere in between ([fleet vision](../fleet-vision.md)).

The Fleet page is **not** the inbox: it never demands a reply. It is **not** a permission or visibility boundary: any agent stays reachable and messageable whatever surface it appears on. It is **not** a Squadron container view: the Squadron scope filters and the Squadron list selects, and neither walls.

## Acceptance criteria

### The sidebar

1. The sidebar's scope control offers the Squadrons of the environment and "all", and the list shows only threads whose Squadron home matches the selection.
2. A sidebar row shows the agent's Squadron and a relative time on its first line, the title on its second, and the status label with the provider icon on its third; worktree and branch live in the hover tooltip, which also carries a measured status line.
3. No agent thread is hidden from the sidebar on account of how it was created; snooze, settle and pin behave as upstream defines them.

### Entering the page

4. The Fleet page opens from a rail-footer entry and from the command palette, as a full-width page in the main view.
5. While the page is open, the sidebar is replaced by a list of every Squadron in the environment, each with its count of agents that have a measured problem.
6. The page shows exactly one Squadron, the one selected in that list; it opens on the sidebar's scoped Squadron when there is one and otherwise on the list with nothing selected.
7. Selecting a Squadron on the page does not change the sidebar's Squadron scope, and leaving the page restores the sidebar unchanged.

### The rows

8. The rows are every registered agent participant whose home is the selected Squadron, with no cap on their number; a large Squadron is paged or virtualized, never silently truncated.
9. Rows are arranged as the placement tree, siblings in creation order, and are never reordered by activity or by problems.
10. People are never rows; a person appears only as the counterparty on an agent's asks. Provider-native Subagents never appear.
11. Every retired agent on the path from the Squadron to an active agent renders as a dimmed placeholder in its tree position, with its cells marked not applicable rather than unknown; its descendants stay beneath it; a retired agent with no active descendant is not shown.
12. Each row shows its provenance as a fact: spawned by which agent, forked, or unrecorded.
13. Threads in the environment that have no Squadron home are not rows; one footer line states how many there are (unarchived, excluding provider-native Subagents), and no Squadron is invented for them.
14. Clicking a row opens the agent's thread.

### The four facts

15. Status shows the runtime's own fact: Working, Waiting, Approval, Input or Failed; "Waiting to start · Nm" takes precedence while a run has been requested and not dispatched; "Idle since ⟨time⟩" appears only when nothing is active and no background work remains.
16. Read and snooze bookkeeping (upstream's Woke and Done) is not a status and does not appear.
17. Silence notices are not shown on the page; the age of an open ask is the visible fact.
18. Open asks show two counts, "Owes N" for open asks the agent must answer and "Awaiting N" for open asks it is waiting on, with a hover list of counterparty, intent and age; a follow-up joined to an open Exchange counts once.
19. Last activity is the latest measured event, labeled by what it was (for example "last turn ended 14:02"); the page never shows a vague "last seen".
20. Any fact the page cannot measure renders as `?` with the reason on hover; the row still renders, and no label is derived from a partial set of facts.

### Problems and the badge

21. A row's measured problems are a failed latest run, a delivery alarm, and a run that has waited past the dispatch threshold; the row lists every one it has.
22. A delivery alarm is shown on the sender's row as "Delivery failed · to ⟨receiver⟩ · ⟨time⟩ · ⟨reason⟩" and stays while the fact is true; it is never inferred repaired ([agent-to-agent communication](../a2a/index.md)).
23. The badge counts agents that have at least one measured problem across every Squadron the page reads; an agent counts once however many problems it has, unknowns never count, and the badge never counts open asks to the person or silence notices.
24. A delivery alarm counts toward the badge only while the Exchange it belongs to is open; an alarm on a plain message is shown on the row and never counted; a failed delivery of a platform-authored notice is neither shown nor counted.

### Freshness and environment

25. The page header names the environment the facts came from and the time as of which they were read; how several environments merge on the page is defined in [cross-device](../cross-device.md).

### Cost

26. The Squadron list shows each Squadron's measured cost, and a Squadron's page shows what each of its agents contributed.

## Scenarios

- **Reading one Squadron.** The user selects Billing Migration on the page's Squadron list. The coordinator agent is the first row; the two builders it spawned sit indented beneath it in the order they were created, each showing status, owed and awaited asks, and last activity. Clicking a builder opens its thread. (AC6, AC8, AC9, AC12, AC14)
- **A run that never started.** A builder's run has sat undispatched for seven minutes: its status reads "Waiting to start · 7m" and the badge counts it. When the run starts, the status changes and the badge drops. (AC15, AC21, AC23)
- **Owed and awaited.** An agent owes one answer to its coordinator and is waiting on two peers: "Owes 1 · Awaiting 2", with all three listed on hover with their ages. (AC18)
- **An orphan.** A coordinator is archived while two builders it spawned are still working: its row dims to "retired" in place, and the builders stay beneath it, still Working. (AC11)
- **A fact that cannot be read.** The placement query fails for one agent: its placement cell shows `?` with the reason on hover, the row renders, and the badge is unchanged. (AC20, AC23)
- **Two problems, one agent.** An agent's latest run failed and it also has a delivery alarm: the badge counts it once and its row lists both. (AC21, AC23)
- **Silence.** A silence notice exists for an agent: nothing on the page changes; its status is whatever the runtime says and the owed ask's age is the visible fact. (AC17)
- **Where is the problem?** The rail badge shows 2. Opening the Fleet page replaces the sidebar with the Squadron list, where Billing Migration shows 2 and Website Redesign shows 0. Choosing Billing Migration shows both failing agents; leaving the page restores the sidebar with its scope as it was. (AC5, AC7, AC23)
- **As of when.** The header reads "Fleet · work server · as of 14:02:31"; a saved home server's Squadrons do not appear on this page, and the page does not claim they do. (AC25)
- **Threads without a home.** Three threads created before Squadrons existed have no home: the footer says so, and none is a row. (AC13)
- **A failed delivery.** An agent's ask to its coordinator fails to deliver: its row shows "Delivery failed · to ⟨coordinator⟩ · 14:02 · ⟨reason⟩" and the badge counts it. The agent clears its ask: the chip stays, and the badge no longer counts it. (AC22, AC24)
- **The user is not a row.** An agent in Support Rotation has an ask out to the user: the user is not a row on the page; the ask appears in that agent's "Awaiting" list with the user as counterparty. (AC10, AC18)

## History

- 2026-08-29 — the three-surface model, the Squadron scope, row language, and the roster as a Fleet page settled; former SB1–SB7 ([record](../../worklog/2026-08-29-sidebar-roster-session.md)).
- 2026-09-04 — the Fleet page specified: one Squadron at a time from its own Squadron list, agents only, the four facts, silence notices omitted, the global badge, delivery alarms, orphans; the sidebar membership-by-provenance rule dropped; former FV1–FV11 ([record](../../worklog/2026-09-04-fleet-visibility-session.md)).
- 2026-09-05 — status vocabulary corrected against the runtime's resolver (same record).
- 2026-09-10 — rewritten into the definition shape and renamed from "Sidebar & roster". Former identifiers: SB1 → Definition; SB2 → AC3; SB3 → AC1; SB4 → AC2; SB5 → dropped (AC3 says the opposite); SB6 → AC4–AC14; SB7 → the inbox definition; FV1 → Definition, AC20; FV2 → AC15–AC17; FV3 → AC18; FV4 → AC19; FV5 → AC21, AC23; FV6 → AC20, AC25; FV7 → AC5–AC13; FV8 → AC3; FV9 → not a product matter (the server reads belong to the build); FV10 → the deferred items are backlog candidates, not part of this definition, except cost, which the fleet vision requires and AC26 carries; FV11 → AC22, AC24; the v0 override DV6 → AC3. The sidebar label's "extended with silence states" clause is not restated: silence facts are defined by agent-to-agent communication, and where they show is that definition's call. Mockup references are gone: mockups are decision aids in a design workspace, not part of the definition.
