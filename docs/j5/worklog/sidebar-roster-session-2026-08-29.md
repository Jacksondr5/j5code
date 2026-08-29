# Sidebar/roster design session — rulings record (2026-08-29)

Jackson + UI/UX design agent; dogfood-v0 UX workstream (area 3 of the
dogfood UX map). Scope: how agents are presented in the left rail and how
the whole fleet stays visible. Method per Jackson's direction: direction
conversation first, then HTML mockup options rendered in the design
workspace (`product/fleet-sidebar/mockups/`), styled against **real app
references** (screenshots captured from a live instance +
`apps/web/src/index.css` tokens). Mockups are decision aids, not pixel
specs. Feature doc of record: [`../product/features/sidebar-and-roster.md`](../product/features/sidebar-and-roster.md).

Research inputs (in the workspace record): a code sweep of upstream's
default sidebar (flat list; static creation order — activity never
reorders; snoozed > pinned > settled > active partition; six-state row
status machine; subagent threads filtered out entirely) and an inventory
of J5-tracked facts (exchange urgency, silence taxonomy, delivery alarms,
placement/provenance, A4 inbox projection).

| ID  | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SB1 | **The three-surface attention model.** Sidebar = conversations in motion, recency-sorted (the agents the user is actively talking to). Inbox = high-certainty "needs me" (decisions asked of the human; fallen-over agents). Dashboard/roster = overall health and low-certainty judgment discovery ("this Crew has been stalled 5h — is that wrong?").                                                                                                 |
| SB2 | **Sidebar keeps upstream's structure and mechanics.** Recency sort as users expect; snooze/settle/pin left exactly as-is — revisit post-dogfood when observed ergonomics say which mechanics matter. (Assessment recorded for that revisit: inactivity auto-settle conflicts with idle-as-real-state; snooze must never hide inbox items.)                                                                                                              |
| SB3 | **SC3 amended: Squadron scope dropdown, not Squadron grouping.** Upstream's project-scope dropdown becomes a Squadron scope dropdown — scope to one Squadron when focused, zoom out when triaging. Composer context inheritance sources from the scope selection. Jackson's meta-ruling: the grouped-sidebar clause was a product/UI decision, not doctrine — changeable as design proceeds. `squadron.md` §Creation UX and SQ1 updated in this commit. |
| SB4 | **Row language.** Line 1: Squadron + relative time (time yields to snooze/✓ Settle on hover, per upstream). Line 2: title. Line 3: status label (upstream's vocabulary extended with J5 silence states) + provider icon. Worktree/branch demote to the existing hover tooltip, which gains a measured status line. Neutral styling — no invented chip tints.                                                                                            |
| SB5 | **Sidebar membership = provenance rule (v0 starting point).** Human-created agents appear in the sidebar; agent-spawned Peer Agents are roster-only; pin/hide overrides both ways. Explicitly expected to be refined during dogfooding. (No Roles in v0, so declared posture is unavailable; provenance is the measured stand-in.)                                                                                                                      |
| SB6 | **Roster is v0, as a main-view Fleet page (mockup Option B).** Opened from a rail-footer entry carrying an alert badge; full-width placement tree grouped by Squadron with status, open-asks, and last-activity columns; unknowns render as `?` (never-guess). This is the proto-dashboard item 4 grows out of. Rationale: hiding Background agents from the sidebar requires a surface where they remain visible — status is read, nothing vanishes.   |
| SB7 | **Inbox carries two lanes in principle — designed later.** The obligation queue stays pure (R5); measured high-certainty platform alerts (errored agents, delivery alarms, awaiting-human/human-doesnt-know) may share the surface but never the data model (R5's own seam). The inbox's actual UI/UX is deferred to its own session.                                                                                                                   |

## Deferred / TODO (recorded, not designed)

- Roster row-click behavior (working assumption: opens the agent's
  thread), the alert-badge fact set (working assumption: same set as the
  alerts lane), roster row actions (nudge/archive) — ride implementation
  or a follow-up pass.
- Multi-environment treatment of the Squadron scope dropdown (X2 merge) —
  v0 consciously assumes one environment; the row-level precedent exists
  (upstream's hover tooltip already carries an environment label).
- Representing agents at different points on the human-contact spectrum —
  the sidebar/roster split is the first cut; mid-spectrum agents need
  thought (Jackson's TODO).
- Crew rendering (collapsible units under their Captain) when Crews exist;
  the roster tree is where they land.

## Handoff note

The implementing dev owns technical design within these rulings. Known
data gaps recorded during research: no per-participant last-activity
timestamp is materialized (derive from the ledger) and nothing counts open
exchanges per participant — the roster is the first consumer of both.
