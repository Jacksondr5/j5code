---
title: "Sidebar & roster — how the fleet is presented"
kind: spec
---

# Sidebar & roster

Feature definition of record, settled 2026-08-29 with Jackson
([session rulings SB1–SB7](../../worklog/sidebar-roster-session-2026-08-29.md)).
The problems it serves ([problems doc](../problems.md)): fleet
observability ("it's hard to see what agents you aren't talking to are
doing") and scarce human attention. Approved mockups live in the design
workspace (`product/fleet-sidebar/mockups/`), rendered against real app
references; they are decision aids, not pixel specs.

## The three-surface attention model (SB1)

J5 pushes users toward running more agents while talking to fewer. No
single surface serves both facts, so attention splits three ways:

| Surface     | Job                                                                  | Sort/logic                                                      |
| ----------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Sidebar** | Conversations in motion — the agents the user is actively talking to | Recency, as users expect; upstream mechanics kept               |
| **Inbox**   | High-certainty "needs me" — decisions and measured failures          | Urgency-ranked obligation queue (+ alerts lane, designed later) |
| **Roster**  | Overall health and judgment discovery; home of all hidden agents     | Placement tree grouped by Squadron, status read never asked     |

The observability dashboard (item 4) grows out of the roster; they are one
surface at two maturities, not two surfaces.

## The sidebar (SB2–SB5)

Upstream's default sidebar survives structurally: flat recency list,
snoozed/settled/pinned mechanics untouched (revisit post-dogfood), no
continuous animation, status carried per-row.

J5's deltas:

- **Squadron scope dropdown** replaces the project-scope dropdown (SC3 as
  amended): scope to one Squadron when focused, zoom out when triaging.
  The composer's Squadron context inherits from the scope selection.
- **Row language:** line 1 shows the Squadron (+ relative time, yielding
  to snooze/settle actions on hover); line 2 the title; line 3 a status
  label — upstream's vocabulary (Working/Approval/Input/Failed/Woke/Done)
  extended with J5 silence states — plus the provider icon.
  Worktree/branch demote to the existing hover tooltip, which gains a
  measured status line (e.g. "Working 4m · turn started 14:02").
- **Not all agents appear.** Membership follows provenance (v0 rule,
  dogfood-refinable): human-created agents show; agent-spawned Peer
  Agents are roster-only; pin/hide overrides in both directions.

## The roster (SB6)

A full-width **Fleet page** in the main view, opened from a rail-footer
entry that carries an alert badge. Contents: every agent in the scope,
grouped by Squadron, indented by placement (Crews render as collapsible
units under their Captain once Crews exist), with columns for status,
open asks, and last activity. Unknowns render as `?` — a visibly missing
fact always beats a plausible fake ([never-guess](../principles.md)).

Working assumptions riding to implementation: clicking a row opens the
agent's thread; the alert badge counts measured high-certainty facts
(errored, delivery-alarmed, awaiting-human/human-doesnt-know); row
actions (nudge, archive) are v-next.

## What this feature is not

Not the inbox (obligations live there; the roster never demands a reply),
not a permission or visibility boundary (any agent remains reachable and
messageable regardless of surface), and not a Squadron container view —
the scope dropdown filters, it never walls (E1).

## Deferred (with reasons)

- **Inbox UI/UX** — its own design session; only the two-lane principle
  (obligation queue vs measured alerts, shared UI never shared data
  model — R5) is settled.
- **Multi-environment scope treatment** — v0 consciously assumes one
  environment; the X2 merge question is recorded.
- **Human-contact-spectrum representation** — the sidebar/roster split is
  the first cut; mid-spectrum agents need thought.
- **Snooze/settle evolution** — kept as-is deliberately; post-dogfood
  review decides which mechanics matter (assessment recorded in the
  session worklog).
