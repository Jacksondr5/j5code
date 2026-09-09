---
title: "Playbooks"
kind: definition
---

# Playbooks

## Problem

An agent following a long procedure reads it once at the beginning and the later steps decay into the back pages of its context; by step nine it has forgotten what step nine said. A person watching long-running work cannot see progress at a glance — they see a spinner, not a state ([problems](../problems.md): context as bad memory; fleet observability).

## Definition

A **Playbook** is user-authored, step-by-step content for a piece of work, aimed at either a single Role or a Crew; either can be spawned and told to follow one. In a Crew Playbook each step carries instructions per Role — what the Builder does in this step, what the Sitter does. A single-agent Playbook is the one-participant case.

**The engine is the platform's; the steps are the user's.** The platform holds the step pointer, keeps instructions fresh, and renders progress. The steps, their content, and the judgment that a step is done belong to the Playbook and the agents following it. This is how a workflow like the PR Group becomes expressible on the platform without being codified into it.

It runs in three moves. **An agent declares a step complete** through a tool call, so "what step are they on" is a cheap, honest, measured fact — asserted by the agent, visibly so, never parsed from output or inferred by the platform. **On advance, the platform delivers the next step's instructions to every participant**, each Role receiving its own block for that step, fresh in context; this is what defeats read-once-and-forget. **The interface renders progress** from the step pointer: which step each Crew is on, at a glance.

Playbooks are linear sequences. The initiative-level view — a plan whose nodes are Crews' Playbook positions — is the same idea one level up and is designed as one family with it, but linear ships first. A Playbook is not a workflow engine: no platform-owned branching, retries or step-level automation. Where a step needs judgment, an agent judges.

## Acceptance criteria

1. A Playbook is a user-authored file the platform reads; it never generates or edits steps.
2. A Role or a Crew can be spawned with a Playbook and told to follow it.
3. An agent advances a Playbook by declaring a step complete through a tool call; the platform never advances a step on its own.
4. The current step of every agent and Crew following a Playbook is a recorded fact, attributed to the agent that declared it.
5. On advance, every participant receives its own instructions for the new step in its context.
6. The interface shows which step each Crew and agent is on.
7. A Playbook has no branching, retry, or automation owned by the platform.

## Scenarios

- **A release Playbook.** The user writes a five-step release Playbook with per-Role blocks and launches a Crew in Website Redesign with it. The Fleet page shows "step 2 of 5". When the Builder declares step 2 complete, the Sitter's next turn opens with its step-3 instructions. (AC2, AC3, AC5, AC6)
- **A judgment step.** Step 4 says "decide whether the migration is safe to run"; the platform delivers the instruction and waits — the agent decides, and declares. (AC3, AC7)

## History

- 2026-08-22 — the concept; former R27 ([record](../design-review-2026-08-21.md)).
- 2026-09-08 — rewritten into the definition shape. Former identifiers: R27(a) → AC3–AC4; R27(b) → Definition (linear first); R27(c), skills per step → not part of the definition, parked. The questions for the Playbooks design session — the step schema, how a Playbook attaches at spawn, the delivery channel for step advancement, the initiative-level view, what "declared complete" means for a multi-agent step — are that session's, not this definition's.
