---
title: "The Squadron — J5's grouping concept, defined"
kind: spec
---

# The Squadron (formerly code-named "epic")

Settled with Jackson 2026-08-17, closing the gap the Director surfaced: the term "epic" had been adopted from Traycer research without a J5 product definition, and A2's `join_epic` implemented exclusive membership from that vacuum. This document is the definition of record. **E6 settled same day: the concept is named the *Squadron*** — squadrons make up the fleet. Everywhere earlier documents say "epic" (D3, D8, the A2A plan, the ledger design), read "squadron"; the code rename is scheduled with the Director.

## Definition

A **grouping, not a boundary** — the way sets of agents, artifacts, PRs, human-targeted messages, and their communication ledger are organized around **a large amount of work or a long-running initiative**. It is a filter over shared infrastructure, not an isolation wall: messaging crosses it (D8 double-entry), the human node is global, the fleet dashboard aggregates across it, and the filesystem is readable regardless.

| Question | Ruling |
| --- | --- |
| E1 Boundary or label? | **Grouping/label.** Organizes; never isolates. No visibility or permission semantics. |
| E2 Membership | **Single home, no movement.** Multiple homes and movement defeat the purpose of grouping and add complexity with no identified need — cross-epic messaging and filesystem reads already cover the use cases. Membership is assigned at creation and immutable. |
| E3 Contents | **Full container over time**: agents, artifacts, PRs, human-targeted messages (plus the ledger, org tree, and eventually terminals/folder bindings). The A1 minimal entity is a seed, not the end state. |
| E4 Lifecycle & authority | **User-only creation.** An epic represents a large amount of work or a particular long-running initiative — agents never create them. (End-of-life semantics: archive expected; details when the container grows.) |
| E5 Org tree (D10 placement) | **Lives inside a single epic.** Placement moves never cross epic borders. |

## Consequences for the build (the A2 fix)

- **`join_epic` as an agent-facing tool should not exist.** Membership is fixed at creation: a user-created agent gets the epic the user chose; an agent-spawned agent inherits its spawner's epic (E2 + E4 + E5 compose to: agents always spawn within their own epic). There is no join, no leave, no move.
- The ledger's `participant.joined/left` events become **lifecycle events only**: `joined` at agent creation/registration, `left` at archive/retirement. Neither is agent-invocable.
- Exclusive-join's worst property — *silently* leaving other epics — is moot under no-movement, but the principle it violated stands recorded: membership changes, were they ever to exist, must be loud and evented.
- D3/D8 unchanged: per-epic ledger as storage/replication unit; cross-epic exchanges via double-entry.

## E6 — the name: **Squadron** (SETTLED 2026-08-17)

"Epic" mapped too closely to software development for an app that must stay open to non-dev work. **Squadron** won on: it names the *who* (Jackson's chosen axis — the group of agents), it is fleet-native — a fleet is composed of squadrons, so the name reinforces the product's totality word instead of stealing it — and its collision map is completely empty (no code entity, no prg concept, no reserved primitive). Runners-up and vetoes, for the record: *program* (operator-validated but "computer program" for this audience), *mission* (leans bounded), *team* (reserved for the item-3 roster primitive), *group* (PR Group collision), *project* (T3 code-entity collision — the `thread` problem again), *fleet* (steals the totality word). Candidates as originally assessed:

| Name | For | Against |
| --- | --- | --- |
| **Program** (recommended) | Jackson's own fleet operators converged on it spontaneously — "the OTel-removal program," "program lead," "program law" appear throughout the interviews; covers both bounded initiatives and standing departments; ordinary non-dev usage (research program, training program) | "Computer program" ambiguity inside a coding tool |
| **Mission** (runner-up) | Native to the fleet metaphor (fleets fly missions); implies purpose and completion; Mission Control resonance for the dashboard | Leans bounded — a standing "monitoring mission" reads slightly odd |
| Initiative | Jackson's own defining word; non-dev | Wordy; no energy; terrible abbreviation |
| Fleet | Leans into the product identity | **Steals the word for the totality** — "the fleet" naturally means all your agents; making it one grouping creates fleets-of-fleets confusion and breaks "fleet dashboard" |
| Group | Maximally neutral | Collides with PR Group (the canonical workflow unit) and the coming team/roster primitive; carries no meaning |
| Project | Familiar | Collides with T3's existing project concept; still dev-flavored |

Rename cost is at its lifetime minimum right now (fresh state, one migration, few contracts); it grows with every A2A milestone that lands.
