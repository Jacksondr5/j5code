---
title: "Crews"
kind: definition
---

# Crews

## Problem

Complex work needs a group of agents with defined jobs working together with a high degree of independence from the person — a builder, a reviewer, and a sitter on one pull request is the canonical case. Wiring such a group by hand every time is slow and error-prone, groups that die leave stranded obligations, and a Foreground agent that keeps the person's attention needs somewhere to hand context-heavy work so it can stay responsive ([problems](../problems.md): large unsupervised groups, human attention, more work needs more cleanup).

## Definition

A **Crew** is a group of agents spawned as a unit from a user-authored **Crew definition**: which Roles it contains and how they work together. The definition is the user's content — a file, portable and shareable, git optional, like a Role. (Its artifact form is called a Manifest in implementation vocabulary; at the product level, defining a Crew is the definition.)

**Membership is fixed at spawn.** Counterpart references in the definition ("escalate CI failures to your Builder") resolve once, at spawn, so every member knows how to work with the others without the person wiring them together. A Crew lives entirely inside one Squadron and renders as one node in the placement tree with its members beneath it; anything that acts on the unit acts on all of them.

Crews work their task with high independence until a defined stopping point or completion. They can always reach any other agent in the Squadron directly. Their communication with the person is rarely direct chat: they lean Background, reaching the person through the inbox or through their Captain, and recording deferred items as Memos.

**Definition integrity is checked where it is structured.** A Crew definition that references a Role that does not exist is a visible defect in the library before anyone spawns it. Prose counterpart mentions are never parsed or validated — that is a judgment task, and guessing at it is worse than not checking.

### Captains

Any agent with Crews placed under it is a **Captain** — a derived, measured status, not a platform entity or a tier. The management layer is made of agents in the placement tree, which nests to any depth; there is no container above the Crew.

- **The spawning agent is the Captain.** Whoever spawns and briefs a Crew commands it. Spawning a Crew _for_ someone else is proxy managemen. We do not do that. Instead, send the decision and the brief to the future Captain, who spawns its own Crew.
- **Agents spawn Crews.** Captains running Crews without the person in the loop is the point. Crew _members_ cannot spawn Crews — wanting more hands is an escalation to the Captain — and the tool refuses a member with an error naming that next step.
- **A Captain may archive the Crews directly under it** — the only agent-invoked archive, and it triggers the same loud machinery as any archive. Not grandchild Crews, not individual members, not solo agents.
- **Captains are never routers.** Any participant may message any participant; the hierarchy carries decisions, never messages.
- A Captain shows a Captain chip; its Crews render as collapsible groups.

### Lifecycle

Crews are deliberately disposable. They **archive only as a unit** — members are never individually archived or replaced — because an agent's death is usually recoverable by messaging it again, and an irrecoverably poisoned member has likely contaminated its crewmates. Recovery is **respawn from the definition**, which is cheap because a Background Crew's value lives in its definition and its durable artifacts — worktree, branch, pull request — which survive the agents. Two platform rules make this safe: archive never destroys work, and archive is loud, with every open Exchange ending in a notice to its waiter.

**Archive and respawn are judgment moments, and the platform never makes that decision itself.** Archiving a Crew with open Exchanges warns with the count and the list and requires confirmation; the expectation, carried in guidance rather than enforced, is that a Captain checks with the person and they plan together. The successor Crew gets a fresh brief written by whoever respawns it — where things stand, the state of the durable artifacts, what to do next. There is no auto-forwarded original brief, no generated summary, no transferred conversation, no inherited obligations, no auto-reopened asks; the archived Crew's brief, ledger and artifacts stay readable for the respawner to consult.

The platform ships the machinery — define, spawn, render, warn, archive. The Playbook a Crew follows and the Roles it contains are always the user's content: the PR Group is one Crew definition someone wrote, never the product's opinion.

## Acceptance criteria

### The definition

1. A Crew definition is a file the user can read, copy and share, naming the Roles it contains and their wiring; git is optional.
2. A Crew definition that references a Role that does not exist is shown as a defect in the library before spawn.
3. Prose in a Crew definition is never parsed or validated.

### The unit

4. A Crew spawns as a unit, with membership fixed at spawn and counterpart references resolved at spawn.
5. A Crew lives in exactly one Squadron and renders as one node in the placement tree with its members beneath it.
6. A Crew is launched with a brief, and the launch surface is visibly different from starting a chat with a single agent.
7. Every Crew member can message any participant in the Squadron, and the Crew's contact with the person goes through the inbox or its Captain rather than chat.

### Captains

8. An agent with Crews placed under it shows a Captain chip, derived from placement and nothing else.
9. An agent can spawn a Crew from a user-provided definition within its own Squadron; the Crew is placed under the spawner.
10. A Crew member's attempt to spawn a Crew is refused with an error naming escalation to its Captain.
11. A Captain can archive a Crew placed directly under it; it cannot archive a grandchild Crew, a single member, or a solo agent.

### Lifecycle

12. A Crew archives only as a unit; no member can be archived or replaced individually.
13. Archiving a Crew never deletes a worktree, branch or checkpoint.
14. Archiving a Crew with open Exchanges shows the count and the list and requires confirmation; every waiter receives a notice.
15. A respawned Crew starts from the definition and the respawner's brief only; nothing from the archived Crew's conversation, obligations or asks is carried over automatically.
16. A Crew shows a drift indicator when any of its definition files changed since it was spawned.

## Scenarios

- **A pull-request Crew.** The user defines "PR Crew" — Builder, Reviewer, Sitter — with "escalate CI failures to your Builder" in the Sitter's wiring. A Captain in Billing Migration spawns it with a brief for one pull request; the three agents appear as one node under the Captain, the Sitter's reference already resolved to that Builder. (AC1, AC4, AC5, AC9)
- **More hands.** The Builder wants a helper Crew and tries to spawn one; the tool refuses and names escalation to the Captain. (AC10)
- **A poisoned Crew.** The Reviewer has gone wrong and confused its crewmates. The Captain archives the Crew; the dialog lists two open asks; the Captain confirms after checking with the user, writes a fresh brief from the surviving branch and pull request, and spawns a successor. (AC12, AC14, AC15)

## History

- 2026-08-21 — the concept: definition versus instance, archive as a unit, archive never destroys work, agents spawn Crews, one Squadron, Captains as derived status, Captain archive rights, members cannot spawn Crews, "you command what you brief", Captains never routers; former R12–R22 ([record](../../worklog/2026-08-21-design-review.md)). "Team" retired as a word.
- 2026-08-23 — the product session: structured-only validation, archive and respawn as judgment moments with a fresh brief; former P-E and J1–J3 ([record](../../worklog/2026-08-23-roles-crews-session.md)).
- 2026-08-24 — whether Crew members may spawn solo Peer Agents is deliberately left open until Crews are built and a real Crew's behavior can be observed ([record](../../worklog/2026-08-24-spawn-terminology-session.md)).
- 2026-09-08 — rewritten into the definition shape; "git-versioned" aligned with Roles ("git optional"); posture stated as a lean, not a rule. Former identifiers: R12 → AC1; R14 → AC12; R15 → AC13; R16 → AC9; R17 → AC4–AC5; R18 → AC8; R19 → AC11; R20 → AC10; R21, R22 → Captains; P-E → AC2–AC3; J1–J3 → AC14–AC15. The open question on members spawning solo Peer Agents stays open, recorded above.
