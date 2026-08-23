---
title: "Dogfood v0 — build J5 Code from J5 Code"
kind: story
status: 1
---

# Dogfood v0

**Goal (Jackson, 2026-08-23):** get J5 Code to the state where development of J5 Code happens _inside_ J5 Code — the second critical step (after the docs effort) toward other people being able to help. Once this milestone completes, well-ticketed work is farmable to any contributor in the right order.

**Definition of dogfood-ready:** crews run as J5 threads, communicate over the A2A ledger, and reach a person in the in-app inbox whose verbatim answer closes the exchange — with archives terminating obligations loudly instead of stranding them.

## Phases

| Phase             | Work                                                                                                                                                                                                                                                                                  | Runs in                                 | Gate to next                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| **0** (in motion) | Registrar service → A6 rebase + wrapper-path live proof + runbook                                                                                                                                                                                                                     | Traycer                                 | Proof passes; membership provisioning real |
| **1**             | **A4** (person node + inbox) ∥ **A9** (lifecycle closure) — parallel crews                                                                                                                                                                                                            | Traycer                                 | Both merged                                |
| **2**             | **A10** (silence fact bundles) + **A8** (envelope true-up) — coordinated pair (shared formatter surface)                                                                                                                                                                              | Traycer                                 | Both merged                                |
| **3**             | **Jackson's solo dogfood**: Jackson personally runs a small real task inside J5 Code — spawns agents, they exchange over the ledger, asks land in his inbox, he answers in-app, archives behave. No crew, no hand-off — his own shakedown. Friction list captured as the retro input. | **J5 Code** (Jackson only)              | Jackson satisfied                          |
| **4**             | **First crew inside J5**: one real ticket (A5 if still open, else next priority) run with Builder/Reviewer/Sitter as J5 threads over A2A. Director still directs from Traycer. Crew retro = the prioritizer for Roles/Crews (item 3), Memos, and item-4 panes.                        | **J5 Code** (crew) / Traycer (Director) | Retro delivered                            |

## The line: when development moves from Traycer to J5

- **Phases 0–2 run entirely in Traycer** — current PR-group practice, unchanged.
- **The cutover is phase 3, and it is Jackson-first**: he dogfoods personally before anything is handed to crews or other people. Nothing else migrates until he's satisfied.
- **Crews move at phase 4; the Director moves last** — Traycer remains the command deck until the phase-4 retro says J5 Code can hold it. Migrating the Director is explicitly OUT of v0 scope and is decided by that retro.
- Sharing tickets/designs with other human devs: later, Jackson's call — not part of v0.

## Opportunistic / standing (any phase)

- **A5** (graph read API) staffs whenever lane capacity allows — approved, amended, no dependencies beyond A2.
- **A7** (upstream rebase) fires whenever pingdotgg#2829 merges and briefly preempts everything (expected: days).
- 4a (PR pane, issue #6) continues with the human engineers independently.

## Explicitly NOT v0

Roles/Crews implementation (item 3 — design session completed 2026-08-23 ahead of the retro; feature docs are the build-ready contract, rulings at [roles-crews-session-2026-08-23.md](roles-crews-session-2026-08-23.md); staffing is a separate call), Memos, Playbooks, Shared Squadrons, item-4 panes, Director migration, multi-dev ticket sharing.
