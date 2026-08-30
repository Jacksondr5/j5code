---
title: "The Spawning Guide — selection and brief guidance for whoever spawns"
kind: spec
---

# The Spawning Guide

Feature definition of record ([worklog record](../../worklog/spawning-guide-session-2026-08-30.md)). Origin: the rebuilt `spawn_agent` contract ([agent-tools.md](../a2a/agent-tools.md), PR #15) makes provider/model/reasoning **required** on every Peer Agent spawn (Jackson, 2026-08-29: inheriting the spawner's setup is wrong more often than right) — which turns every spawn into an explicit choice, and an explicit choice needs somewhere to learn from. That contract carries a come-back note reserving exactly this territory; this document closes it.

Prior art is Jackson's own fleet ([interview synthesis](../../research/jackson-prior-art/fleet-interviews-synthesis.md)): its selection guide was the department's **main cost instrument**, updated mid-program from observed need (the Sitter tier change — identical mechanical reliability on the cheaper tier, at the cost of channel noise; a real, measured tradeoff). Its one recorded failure was **silence**: a spawner had to pick a tier the guide didn't cover, and the retro judged the gap itself worth a line. Traycer's agent selection guide is the same mechanism in the wild — guidance the spawn tooling tells you to read before creating an agent.

## SP1 — Ownership split: platform ships mechanism, user ships judgment

- The guide is **user-authored markdown**, living with the Role library (same substance rules as Roles, R28: a file — portable, shareable, git optional; edited in-app like any library content). One guide in v1.
- The **platform's layer is factual**: the provider/model/reasoning catalog is platform truth (`orchestrator_capabilities` — ids, labels, option descriptors, cost tiers where known). The guide never restates the catalog; it **assigns it to kinds of work**. The judgment layer — which tier for which work — is the user's, evolved from observed need the way Jackson's fleet evolved theirs.
- The **spawn surface points at the guide**: `spawn_agent`'s contract directs the spawner to consult it before choosing. How it is delivered to the agent (tool, listing, resource) is technical design, dev-owned. Humans read it where they read everything else in the library.
- Any example guide the product ships is **user-space content, never the product's opinion** — the same law that governs Playbooks and the PR Group Crew definition.

## SP2 — Scope: two sections, deliberately no third

1. **Selection guidance** — which provider, model, and reasoning effort for which kinds of work, and which Role to reach for when one fits. This is the user's cost instrument. The quality bar comes from the prior art: tier guidance earns its place by **observed behavior per tier**, not vibes — and a good guide **states what it does not cover**, so a spawner facing a gap knows to flag it rather than guess (never-guess applies to guide readers too).
2. **Brief conventions** — what a good first-turn brief contains. This includes the **report-back contract**: the brief itself states what the spawn reports and when (completion, blockers, decision points). When you spawn, you hear back when your brief says you will — the contract travels in the brief, not in platform law.

**Communication norms are deliberately not in the guide** (Jackson, 2026-08-30). How agents converse after spawn is governed by A2A law (Exchanges, delivery receipts, typed silence) and by operator content (Role Operating Principles, Playbooks). The guide governs the moment of spawning; it does not regulate the relationship afterward.

## SP3 — Roles compose, never collide

Provider/model/reasoning stay **required and explicit** on every agent-invoked spawn, Role or no Role. A Role's allowlist **constrains** the required choice (an out-of-list pick is an error naming the Role that excludes it); it never silently substitutes a default on the tool surface. The human composer keeps its ruled behavior unchanged ([roles.md](roles.md): first allowlisted entry as visible-cue default). The guide's territory is what the allowlist cannot decide: role-less spawns, and **which Role to pick** — cross-Role comparison lives here, complementing the per-Role purpose/posture/cost-tier the spawn listing already carries.

## SP4 — Closing `spawn_agent`'s held slot _(settled 2026-08-30, as amended by Jackson)_

The contract's come-back note deliberately left the description with "no spawn-then-ask steering until that guide rules." Ruled:

- **The description gains exactly one sentence of brief steering** (Jackson's amendment to the proposed empty closure): _"In your brief, tell the new agent what it should do first and whether it should reply to you."_ The report-back contract still travels in the brief (SP2.2) — the tool's only coaching is the reminder to write it. Folding the sentence into the contract is with the Architecture agent (the `agent-tools.md` owner); the implementation string change rides wherever that contract lands.
- **Receipt-ACKs: nothing is written anywhere.** The platform measures delivery (ledger receipts) — a social "got it" message is structurally redundant, and the prior-art fleet had to ban exactly that noise once courtesy-acks took hold. If ack noise appears in dogfood, the remedy is a line in the _user's_ guide then, added from observed need — not platform law now.
- **Mid-first-turn delivery mechanics** (what happens when a send lands while a fresh spawn is still working its brief) are A2A delivery design — the Architecture lane's question, never guide content.

## Requirements on landing

- The build that ships the guide mechanism **must update the `spawn_agent` contract in [agent-tools.md](../a2a/agent-tools.md) and the tool implementation together** — the come-back note is closed by this feature, not orphaned.
- **This feature does not block PR #15** (Jackson, 2026-08-29, via the Architecture agent).

## Example guide (user-space content — a seed for Jackson to edit, not a spec)

The shape below is seeded from the prior-art fleet's observed guide behavior. Everything in it is the user's judgment to change.

```markdown
# Spawning guide — <fleet name>

## Selection

| Kind of work                                                | Provider/model   | Reasoning | Why (observed)                                        |
| ----------------------------------------------------------- | ---------------- | --------- | ----------------------------------------------------- |
| Review, judgment calls, anything that rules on others' work | <frontier model> | high      | Misses at lower tiers showed up in re-review cost     |
| Building against a written spec                             | <mid model>      | medium    | Equal outcomes to frontier on spec'd work; cheaper    |
| Mechanical watch/report loops (sitter-shaped)               | <cheap model>    | low       | Identical reliability; narrates more — accepted noise |

Role-ful spawns: pick from the Role's allowlist; first entry unless the task says otherwise.

## Not covered (flag it, don't guess)

Long-context research tiers; anything security-sensitive. If your work isn't on this table,
say so in your thread and pick conservatively — the gap is guide feedback.

## Brief conventions

- Lead with intent — why this work exists, not only what to do.
- Tag what you know as measured vs inferred; the spawn cannot tell the difference otherwise.
- Rules that must survive the spawn's whole life go in the brief explicitly.
- State the report-back contract: what to report, when (completion, blockers, decision points).
- Record traps as open questions in the brief, never as silent assumptions.
```

## Deferred (with reasons)

- **Per-Squadron or per-Crew guide overlays**: one guide in v1, like one Role library location — extend when wanted.
- **Technical design** (file discovery, how the guide reaches the spawning agent, capabilities cost-tier plumbing): owned by the implementing dev, within these rulings.
