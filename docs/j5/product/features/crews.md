---
title: "Crews — groups of agents spawned and retired as a unit"
kind: spec
---

# Crews

Feature definition of record. The problems and goals it serves ([problems doc](../problems.md)): complex work needs groups of agents with defined Roles working with high independence from the user — and Foreground agents need somewhere to delegate context-heavy work so they can stay responsive touchpoints. Rulings baked in: R12–R20 and R21–R22 in [the register](../design-review-2026-08-21.md), plus the item-3 product session ([worklog record](../../worklog/roles-crews-session-2026-08-23.md)).

## The Crew

A **Crew** is a group of agents spawned as a unit from a user-authored, git-versioned **Crew definition** — the [Roles](roles.md) it contains and how they work together. (The definition's artifact form is called a _Manifest_ in implementation vocabulary; at the product level, defining a Crew _is_ the definition.) The canonical example is the PR Group: a Builder, a Reviewer, and a Sitter working one PR end to end.

- **Membership is fixed at spawn.** Counterpart references ("escalate CI failures to your Builder") resolve at spawn, so every member knows how to work with the others without the human wiring them together.
- **A Crew lives entirely inside one Squadron** and renders as one node in the org tree, with its members beneath it — cascade operations treat it as a unit.
- Crews work their task with high independence, until a defined stopping point or completion. They can always reach any other agent in the Squadron directly — but their communication with the user is rarely direct chat: they are Background agents, reaching the human through the inbox or their Captain, and recording deferred items as [Memos](memos.md).

**Definition integrity is checked where it's structured**: a Crew that references a Role that doesn't exist (missing file, renamed) is a visible defect in the library before anyone spawns it. Prose counterpart mentions are never parsed or validated — that's a judgment task, and guessing at it is worse than not checking ([never-guess](../principles.md) applies to validators too).

## Command: Captains

Any agent with Crews placed under it is a **Captain** — a derived, measured status, not a platform entity or a tier. The management layer is made of agents in the placement tree, which nests to any depth; there is no container object above the Crew.

- **"You command what you brief"** (R21): whoever spawns and briefs a Crew commands it — spawning a Crew _for someone else_ is proxy management; instead, send the decision and brief to the future Captain, who spawns its own Crew. Placement = spawner, always; human-only re-parent is the sole exception.
- **Agents spawn Crews** (R16) — Captains running Crews without the human in the loop is the point. Crew _members_ cannot spawn Crews (R20, enforced in the tool surface): wanting more hands is an escalation to your Captain.
- **A Captain may archive the Crews directly under it** (R19) — the only agent-invocable archive; it triggers the same loud platform machinery as any archive.
- **Captains are never routers** (R22): any participant may message any participant; [the hierarchy carries decisions, never messages](../principles.md).
- UI: a Captain chip; its Crews render as collapsible groups.

## Lifecycle: deliberately disposable

Crews archive **only as a unit** — members are never individually archived or replaced (R14). Rationale: agent death is usually recoverable (message them again), and an irrecoverably poisoned member has likely contaminated its Crewmates. Recovery is **respawn from the definition**: cheap, because a Background Crew's value lives in its definition and its durable artifacts (worktree, branch, PR), which survive the agents — the successor Crew picks up where the old one left off. Two platform rules make this safe:

- **Archive never destroys work** (R15): no worktrees, branches, or checkpoints deleted by default; workspace cleanup is a separate explicit act.
- **Archive is loud** (R1/R2): open Exchanges terminate with notices to every waiter, who can reopen against the successor with `regarding`.

## Archive and respawn are judgment moments — the platform composes nothing

Settled in the item-3 session, from the poisoned-Crew scenario:

- **Archiving a Crew with open Exchanges warns loudly**: the archive action surfaces the count and the list (who is waiting, on what) and requires explicit confirmation. The expectation — carried in guidance at the moment of action, not enforced — is that a Captain in this situation **checks with the human**: they make a plan together (what happens to the open decision, who tells the waiters, what the successor needs) and implement it.
- **The successor Crew gets a fresh brief, written by the respawner**: where things stand, the state of the durable artifacts, what to do next. The platform does **not** compose it — no auto-forwarded original brief, no generated state summary, no transferred conversation history, no inherited obligations, no auto-reopened asks. Every one of those is a judgment call, and this is an extreme judgment task.
- What the platform does provide is **the record to consult while writing**: the archived Crew's brief, ledger, and artifacts remain readable forever (R11), and the surviving worktree/branch/PR are visible facts.

## Platform and content

The platform ships the machinery — define, spawn, render, warn, archive. The Playbook a Crew executes and the Roles it contains are always the user's content: the PR Group is one Crew definition someone wrote, never the product's opinion.

## Deferred (with reasons)

- **May Crew members spawn solo Peer Agents?** Deliberately open (Jackson, 2026-08-24) — worth deciding when Crews are being built and a real Crew's behavior is observable, difficult to discern before. Fixed context for whoever closes it: R20 (members cannot spawn Crews) is untouched either way; members' _Subagent_ use is unregulable by construction (glossary, ST4); provenance + placement mean a member-spawned Peer Agent would be visible and contained under the member — the prior-art hazard was invisibility, which no longer exists. Both positions are one-line rulings away.
- **Crew-spawn human UI**: owned by the implementing dev. One requirement recorded: it must be differentiated from solo Role spawn — a Crew is _launched_ as a unit with a brief, not started as a chat.
- **Technical design** (definition schema, wiring format, tool schemas, brief delivery mechanics): owned by the implementing dev, within these product rulings.
