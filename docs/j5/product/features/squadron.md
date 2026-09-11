---
title: "Squadron"
kind: definition
---

# Squadron

## Problem

Managing a large fleet of agents doing large, long-running work needs a unit to organize around — where things belong, what the user picks between, what a ledger is scoped to — without building walls that stop agents from reaching each other ([problems](../problems.md): fleet observability; T3's single flat list of agents keyed to folders). Upstream's unit is the folder: open a folder, get a project, base agents on it, one to one. Work is not shaped like that: many efforts touch one repository, and one effort touches several.

## Definition

A **Squadron** is the user-created grouping of agents, their work — artifacts and pull requests — and their communication ledger, organized around a large amount of work or a long-running initiative. Squadrons make up the fleet; the name is fleet-native and names the group of agents (the naming session and the candidates it rejected are in the [record](../../worklog/2026-08-17-squadron-naming.md)).

A Squadron is **a grouping, never a boundary**. It organizes; it never isolates. It carries no visibility or permission semantics: any agent can message any participant in any Squadron, people are global rather than per-Squadron, the Fleet page reads across Squadrons, and the filesystem is readable regardless of Squadron.

Every agent has exactly one **Squadron home**, recorded by the **Registrar** when the agent is created and never changed afterward. A user-created agent gets the Squadron the user chose; a Peer Agent inherits its spawner's. There is no joining, leaving, or moving between Squadrons; the placement tree of a Squadron lives entirely inside it.

Only a person creates a Squadron. Agents never do, and the platform never creates one automatically — an unnamed default container is the junk drawer that defeats the concept. Creating one is deliberately small: a name and one folder are required; a description and further folders can be added later. First run begins by creating the first Squadron, because agents need a home.

A Squadron **targets folders** rather than living in one: the Squadron is created first and targets one or more folders on one environment, while the same folder may be targeted by many Squadrons. Targeting is a **palette, never a wall** — when an agent is created in a Squadron, the Squadron's folders are offered first, and everything else on the machine stays reachable.

The Squadron is **the unit of user choice**. Every surface where a person chooses a working context offers Squadrons; upstream's "project" is implementation substrate that a Squadron references, never a noun the user picks. Agent creation takes its Squadron from where the person already is — the sidebar's Squadron scope — and shows it in the composer, changeable until send and immutable after. Agents never see any of this: a spawned Peer Agent inherits its spawner's Squadron.

Within a Squadron, agents are organized in a **placement tree**. An agent's **placement** is where it sits in that tree: under its spawner, unless a person moves it. Whoever briefs an agent commands it, so the tree shows who is running what. An agent's **provenance** is the recorded fact of how it came to exist — created by a person, spawned by a named agent, forked from another, or unrecorded — written once and never changed. Neither placement nor provenance restricts who may message whom; the tree carries decisions, never messages.

End of life is archive; its details arrive with the container's growth.

## Acceptance criteria

1. A Squadron never restricts visibility or messaging: an agent in one Squadron can message any participant in any Squadron, and a message that crosses Squadrons is recorded in both Squadrons' ledgers.
2. Every agent has exactly one Squadron home, recorded at creation and never changed: a user-created agent gets the Squadron the user chose, a Peer Agent gets its spawner's, and no tool or interface joins, leaves, or moves an agent between Squadrons.
3. Only a person can create a Squadron; none is ever created automatically; first run cannot proceed to creating an agent until a Squadron exists.
4. Creating a Squadron requires a name and at least one folder; a description and further folders can be added at creation or later.
5. A Squadron targets one or more folders on one environment, and the same folder can be targeted by several Squadrons that remain distinct in every list and picker.
6. When creating an agent in a Squadron, the Squadron's folders are offered first and labeled, and everything else on the machine remains reachable below them.
7. Every surface where the user picks a working context offers Squadrons, and "project" never appears as a user-facing choice.
8. The composer shows the Squadron the agent will be created in, in its heading and as a chip, taking its default from the sidebar's Squadron scope; it can be changed until send and not after.
9. Agents never see a Squadron picker; a spawned Peer Agent inherits its spawner's Squadron.
10. The placement tree lives entirely within one Squadron.
11. Membership is recorded in the ledger as lifecycle events only — joined at creation, left at archive — and neither is agent-invocable.
12. An agent's placement equals its spawner at creation and changes only by a person's action; an agent is never placed outside its Squadron.
13. An agent's provenance is recorded at creation and never changes.

## Scenarios

- **Two efforts, one repository.** The user creates "Billing Migration" and "Website Redesign", both targeting the app repository. Creating an agent in either offers the app repository first; the two Squadrons stay separate everywhere they are listed. (AC5, AC6)
- **First run.** A new install opens on "Create your first Squadron"; the user names it "Billing Migration" and picks the app repository; only then can an agent be created. (AC3, AC4)
- **An agent spawns a helper.** A Peer Agent spawned by an agent in "Billing Migration" has Squadron home "Billing Migration", with no picker shown to the spawner. (AC2, AC9)
- **A message crosses Squadrons.** An agent in "Billing Migration" asks an agent in "Support Rotation" a question; both Squadrons' ledgers carry the Exchange, and nothing about either Squadron blocked it. (AC1)
- **Picking where to work.** Starting a new task from the command palette offers Squadrons; the user picks one and the composer shows it, changeable until send. (AC7, AC8)

## Scope

The current build ([dogfood v0](../../plans/dogfood-v0.md)) narrows this definition in three places: a Squadron has exactly one folder (AC5 narrowed, stored ready to become a list); "Browse elsewhere" may be absent (AC6 narrowed); and the surfaces converted to Squadron choice are the new-thread flow and the command palette first, with the remaining pickers converted by inventory (AC7 in progress). Later: multi-folder targeting, Squadron archive, colors and avatars, migration of pre-Squadron projects. Never: cross-machine targeting; anything boundary-shaped; a Squadron with no folder.

## History

- 2026-08-17 — defined and named; former E1–E6 ([record](../../worklog/2026-08-17-squadron-naming.md); decision log).
- 2026-08-24 — creation and agent-creation experience; former SC1–SC4 ([record](../../worklog/squadron-creation-session-2026-08-24.md)).
- 2026-08-29 — sidebar scope replaces Squadron grouping in the sidebar; former SB3 ([record](../../worklog/sidebar-roster-session-2026-08-29.md)).
- 2026-08-31 — the Squadron is the unit of user choice; former E7 ([record](../../worklog/picker-and-self-messaging-rulings-2026-08-31.md)).
- 2026-09-07 — placement and provenance moved here from the A2A definition (former D10 and R21): they are organization, not communication.
- 2026-09-05 — rewritten into the definition shape. Two changes of substance: a Squadron targets one or more folders, so a folder is required at creation (the name-only Squadron is no longer planned — it would complicate upstream integration) and the folder-required v0 override becomes end-state truth; messages to people are no longer listed as Squadron contents (they belong to the inbox, which is person-scoped, not Squadron-scoped). Former identifiers: E1 → AC1; E2 → AC2; E3 → Definition; E4 → AC3; E5 → AC10; E6 → Definition; E7 → AC7; SC1 → AC5, AC6; SC2 → AC3, AC4; SC3 → AC8, AC9; SC4 → Scope; the A2 `join_epic` consequences → AC2, AC11.
