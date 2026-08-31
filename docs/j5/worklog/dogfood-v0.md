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

## Phase-3 prerequisite (discovered 2026-08-24; design settled same day)

**Squadron-creation + agent-creation UX.** Phase 3 requires Jackson to create a Squadron and create agents under it in-app, but no in-flight work builds that surface — the registrar (#10) deliberately takes an explicit _existing_ Squadron and E4 makes creation user-only. T3's project flow is not reusable: it assumes a 1:1 open-folder→agents shape, while Squadrons↔folders is many-to-many. **Design session complete (SC1–SC4, `../product/features/squadron.md` §Creation UX); build ticket scoped: [SQ1](dogfood-tickets/sq1-creation-surface.md)** — staffs when lane capacity allows, must merge before phase 3. Phases 0–2 are unaffected and do not pause.

## Opportunistic / standing (any phase)

- **A5** (graph read API) staffs whenever lane capacity allows — approved, amended, no dependencies beyond A2.
- **A7** (upstream rebase) fires whenever pingdotgg#2829 merges and briefly preempts everything (expected: days).
- 4a (PR pane, issue #6) continues with the human engineers independently.

## Dogfood work queue (RESERVED — Jackson, 2026-08-31)

Tickets deliberately held as the first J5-native work: NOT staffable in Traycer regardless of free slots. Every ticket is self-contained on repo paths only — dogfood agents have no access to Traycer artifacts or agents. Ladder order:

| Tier                  | Ticket                                                                                              | Size                                     |
| --------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Starter               | [DQ1 — SQ1 cleanup pair](dogfood-tickets/dq1-sq1-cleanup-pair.md)                                   | single agent, hours                      |
| Starter               | [DQ2 — envelope role marker](dogfood-tickets/dq2-envelope-role-marker.md)                           | single agent, hours                      |
| Starter (conditional) | List-own-asks agent read — ticket written if the in-flight measurement confirms no such read exists | small                                    |
| Middle                | [A8 — envelope true-up](a2a-tickets/a8-envelope-true-up.md) (currency note inside)                  | small crew                               |
| Middle                | [DQ3 — palette reuse-or-create hardening](dogfood-tickets/dq3-palette-reuse-hardening.md)           | small crew                               |
| Meaty                 | [A10 — silence fact bundles](a2a-tickets/a10-silence-fact-bundles.md) (currency note inside)        | crew                                     |
| Meaty                 | [A5 — graph read API](a2a-tickets/a5-graph-read-api.md) (currency note inside)                      | crew                                     |
| Meaty                 | [DQ4 — Fleet page pair](dogfood-tickets/dq4-fleet-page.md)                                          | crew (natural phase-4 first-crew ticket) |

NOT held: B4 (archive dialog — phase-3-blocking), and all mid-flight Traycer lanes (B6/B7/E7/#22/#23 finish where they started).

## Queued post-v0 (ratified, waiting on the milestone)

- **Naming audit (Jackson, 2026-08-28):** examine the naming of everything against the settled glossary (Squadron et al.) — headline case: the `j5/a2a` module / `j5_a2a_*` table namespace has grown into the whole fleet-coordination substrate (Squadrons, membership, placement/provenance, messaging), so "a2a" now under-describes it. Rename cost grows with every milestone; run the audit immediately post-dogfood.

- **Auth-subject→person binding (recorded 2026-08-31):** merged #11 authenticates but deliberately does not bind auth subjects to person ids — `resolvePersonId()` is explicit-or-local-default, per R9's "future auth binds to it" design. The binding becomes a product session when multi-person or remote access gets real; no current lane owns it.

- **Claude read-only/dontAsk tool allowlist vs J5 verbs (recorded 2026-08-31):** the provider-side allowlist predates J5 and omits `list_participants`, now a primary steered verb — whether J5 verbs join it is a deliberate product/protected-seam session, not a drive-by on any PR.

- **Orphan policy (re-affirmed at #21 merge, 2026-08-31):** archiving a participant leaves its placed children working but parked under the retired node — no auto-re-parenting (platform composes nothing, per the Roles/Crews ruling; re-parent is human-only per R21, and even that mechanism awaits its rebuild in the placement-display/Fleet-page lane, recovery-recorded from #18). The substrate session's orphan-policy design pass decides what the platform SURFACES about orphans; runs before or with the Fleet page work. Jackson wants follow-up ensured.

## Explicitly NOT v0

Roles/Crews implementation (item 3 — design session completed 2026-08-23 ahead of the retro; feature docs are the build-ready contract, rulings at [roles-crews-session-2026-08-23.md](roles-crews-session-2026-08-23.md); staffing is a separate call), Memos, Playbooks, Shared Squadrons, item-4 panes, Director migration, multi-dev ticket sharing.
