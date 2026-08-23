---
title: "Playbooks — step-by-step work with fresh instructions and honest progress"
kind: spec
---

# Playbooks

Feature definition of record. The problems it serves ([problems doc](../problems.md)): agents executing long playbooks forget later steps — they read them once at the beginning and the instructions decay into the context's back pages; and users can't see the progress of long-running work at a glance (spinners, not state). Ruling baked in: R27 in [the register](../design-review-2026-08-21.md). Backlog candidate, not yet prioritized.

## The Playbook

A **Playbook** is user-authored, step-by-step content for a piece of work, targeted at either a single [Role](roles.md) or a [Crew](crews.md) — either can be spawned and prompted to follow one. In a Crew Playbook, each step carries **per-Role instruction blocks**: what the Builder does in this step, what the Sitter does. A single-agent Playbook is just the one-participant case.

**The engine is platform; the steps are content** (the brief-container pattern). The platform never owns the flow — it holds the pointer, keeps instructions fresh, and renders progress. The steps, their content, and the decision that a step is done all belong to the user's Playbook and the agents executing it. This is how workflows like the PR Group's become _expressible_ on the platform without being codified into it.

## How it runs

1. **An agent declares a step complete via tool call.** "What step are they on" is therefore a cheap, honest, _measured_ fact (with visible asserted-by-agent provenance) — never parsed from output, never inferred. Advancement is always agent-declared, never platform-judged ([facts, never judgment](../principles.md)).
2. **On advance, the platform delivers the next step's instructions to every participant** — each Role receiving its own instruction block for that step, fresh in context. This is what defeats the read-once-and-forget failure: instructions arrive when they're needed, not at turn one.
3. **The UI renders progress** from the step pointer: which step each Crew is on, at a glance — feeding the item-4 progress panes.

## Scope fences

- **Linear step sequences first.** The initiative-level milestone/DAG view is the same primitive one level up — a plan whose nodes are Crews' Playbook positions — designed as one family, shipped linear-first ([simple tools at the frontier](../principles.md)).
- **Skills-per-step is parked, unproven** — it needs the Roles skill story first, and observed need.
- A Playbook is not a workflow engine: no platform-owned branching, retries, or step-level automation. Where a step needs judgment, an agent judges.

## Open — for the Playbooks design session

The step/instruction-block schema; how Playbooks attach at spawn (the Role/Crew definition's Playbook reference); the delivery channel for step advancement (relation to the envelope pipeline); the initiative-level view's shape; what "step declared complete by one member vs. the Crew" means for multi-agent steps.
