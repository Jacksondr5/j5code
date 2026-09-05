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

> **Amended 2026-09-04** (fleet-visibility session with Jackson, rulings
> FV1–FV10 in the [session record](../../worklog/fleet-visibility-session-2026-09-04.md)):
> SB5's sidebar-membership rule is **set aside for v0** (override DV6 in
> [`dogfood-v0.md`](../dogfood-v0.md)); SB6 is specified below into the
> buildable Fleet-page contract. Historical text is kept with dated notes.

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
  _(Set aside 2026-09-04, FV8/DV6: the v0 sidebar is unchanged — no
  automatic hiding, no overrides. Jackson: the rule is too harsh; he asks
  the Director to spawn most of the agents he talks with, and the
  human-contact-spectrum story is not strong enough to build a filter
  yet. Crews, which the user explicitly expects not to talk to, are the
  first exclusion when they exist. Accepted UI gap.)_

## The roster (SB6) — the Fleet page contract (as specified 2026-09-04)

A full-width **Fleet page** in the main view, opened from a rail-footer
entry that carries an alert badge (and a command-palette entry). It
answers four measured questions for every agent the user is not talking
to — _is it doing anything right now_, _is anyone waiting on it or is it
waiting on anyone_, _when did it last do anything_, _is there a measured
problem_ — and clicks through to the thread. Nothing on it is inferred:
no health score, no "stalled", no reordering by urgency, no row actions
(FV1). Unknowns render as `?` with the reason on hover — a visibly
missing fact always beats a plausible fake ([never-guess](../principles.md)).

- **One Squadron at a time (FV7).** The page requires a selected
  Squadron and follows the sidebar's scope dropdown; when the scope is
  "All Squadrons" it shows a Squadron picker, never a merged view.
  Provenance and placement are Squadron-local by construction. Rows:
  registered participants in that Squadron, in a placement tree,
  siblings in creation order — **stable positions, never reshuffled by
  activity**; alerts mark rows, they don't move them. Provenance is a
  rendered fact (spawned by X / forked / unrecorded); provider-native
  Subagents never appear (ST1 — upstream's Agents panel is their home);
  threads without a Squadron home are not rows but are counted in one
  footer line ("3 threads without a Squadron home aren't listed").
  **Orphans:** a retired parent with working children renders as a
  dimmed placeholder row ("retired 09-03") holding its tree position,
  children beneath, no re-parenting; a retired node with no active
  children does not appear.
- **Status (FV2)** is upstream's own six-state row machine (Working /
  Approval / Input / Failed / Woke / Done) plus named facts that exist:
  "Waiting to start · Nm" from the undispatched-run watchdog fact, and
  "Idle since ⟨time⟩" when no run is active. **Silence notices are not
  shown on the page**: with several open asks the current detector
  records only its first match, and "ended without replying" is the
  textbook judgment case (forgot, or waiting on something first?) — the
  notice belongs to the waiter in-thread. The open-ask ages carry the
  measured fact instead.
- **Open asks (FV3):** two numbers — "Owes N" (open inbound asks this
  agent must answer) and "Awaiting N" (open outbound asks) — with a hover
  list of counterparty, intent, and age. Source: the per-participant
  open-exchange read the archive slice built. Coalesced follow-ups count
  as one exchange.
- **Last activity (FV4):** the latest measured event, labeled by what it
  is — v0: the thread's last run start/end from upstream ("last turn
  ended 14:02"); ledger-authored recency joins if cheap. Never "last
  seen".
- **The badge (FV5)** counts agents with at least one measured failure —
  failed latest run, delivery alarm, undispatched-run watchdog fact — and
  **never what the inbox bell counts** (open asks to the human are the
  bell's; R5's own seam, one fact counted once) nor silence notices. An
  agent with two alert facts counts once; the row lists every fact.
  Unknowns never count.
- **Freshness (FV6):** the header states the environment and "as of
  ⟨time⟩"; refetch on interval or focus is acceptable for v0 — the stamp
  keeps it honest. The page reads the primary environment only and says
  so (issue #105 deferred).
- **Data (FV9):** one server read per Squadron returning, per
  participant, identity, home, placement parent, provenance, retired
  flag, run status and timestamps, the watchdog fact, open-ask counts by
  direction with the list, and failure facts — assembled from the reads
  that already exist (identities, homes, pre-archive facts, Squadron
  list). That read is the dashboard-feed part of the A5 graph work,
  delivered small; A5's replay and subscriptions and the A10 fact-bundle
  rework are **not prerequisites**. No fact semantics are trimmed: the
  page never derives a label from partial facts.

Row click opens the agent's thread. Original working assumptions
(2026-08-29) are superseded by the above; the badge fact set no longer
includes awaiting-human.

## What this feature is not

Not the inbox (obligations live there; the roster never demands a reply),
not a permission or visibility boundary (any agent remains reachable and
messageable regardless of surface), and not a Squadron container view —
the scope dropdown filters, it never walls (E1).

## Deferred (with reasons)

- **Fleet-page v-next (FV10, 2026-09-04):** row actions (nudge, archive);
  multi-environment merge (#105); the inbox alerts lane; Crew rendering;
  cost rollups; the PR pane; graph rendering and playback; human-contact-
  spectrum representation; any health inference (never); urgency
  reordering — a "needs attention" filter is the answer, not a re-sort.
- **Sidebar membership rule (SB5)** — set aside for v0 (DV6); returns
  with Crews / the human-contact-spectrum story.
- **Inbox UI/UX** — designed same day; definition of record at
  [`inbox.md`](inbox.md) (IB1–IB7). The two-lane principle (obligation
  queue vs measured alerts — R5) stands; the alerts lane itself is
  post-v0.
- **Multi-environment scope treatment** — v0 consciously assumes one
  environment; the X2 merge question is recorded.
- **Human-contact-spectrum representation** — the sidebar/roster split is
  the first cut; mid-spectrum agents need thought.
- **Snooze/settle evolution** — kept as-is deliberately; post-dogfood
  review decides which mechanics matter (assessment recorded in the
  session worklog).
