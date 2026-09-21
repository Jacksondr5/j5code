# Playbooks

## Problem

A long instruction sequence can fall out of an agent's context, and the person
watching the work needs a visible indication of its current phase.

## Definition

An agent-led Playbook is a live YAML file in the thread workspace containing a
title, purpose, and an ordered sequence of steps with stable IDs, titles, and
prompts. The platform stores an independent run ID, owner thread, definition path,
current step ID, and run status. The agent owns execution and decides when to move.

Each retrieval or movement returns the latest prompt as an MCP tool response in
the existing conversation. Edits are live; reordering preserves the current step
ID. Deleting that ID requires explicit reselection. Invalid or missing files leave
progress unchanged, and cancellation remains available. Back navigation changes
position without undoing work.

Only one run can be active per thread. Completion and cancellation preserve the
agent's usability, and sequential runs retain independent records. Expected-step
guards and durable request IDs prevent stale or repeated mutations from advancing
twice. Provider restarts and context compaction do not end the run.

The thread board on web, desktop, and mobile shows the ordered phases, current
position, and terminal status. Progress expresses the agent's chosen position;
earlier steps are not independently verified successes.

See [the user guide](../../../user/playbooks.md) for authoring and starting a playbook.

## Boundaries

This version has no executable steps, transition graphs, scheduler, or agent
spawning. Squadron management, joining, and messaging already exist independently.
Shared playbook progression and captain authority remain future work related to
[#170](https://github.com/Jacksondr5/j5code/issues/170); independent run identity
allows their ownership policy to evolve without replacing the run model.

No old definition or run migration is included. The implementation scope is tracked
in [#194](https://github.com/Jacksondr5/j5code/issues/194).
