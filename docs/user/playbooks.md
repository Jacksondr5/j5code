# Playbooks

Playbooks give an agent an ordered sequence of prompts. The agent does the work
in its existing thread and decides when to advance. The agent can retrieve its current step and run status throughout the conversation.

Ask your agent to create a playbook, or save a YAML file in your thread's workspace
under `.j5/playbooks/`. For example, `.j5/playbooks/review.yaml`:

```yaml
title: Review a change
description: Understand, inspect, and report on a change.
steps:
  - id: understand
    title: Understand
    prompt: Read the change and identify its intended behavior.
  - id: inspect
    title: Inspect
    prompt: Check correctness and run focused checks where useful.
  - id: report
    title: Report
    prompt: Summarize confirmed findings and remaining uncertainty.
```

Ask your agent to list available playbooks, or say “Start playbook review.” One playbook can be active per thread;
finishing or cancelling it leaves the agent ready for other work or another playbook.

You can edit prompts and reorder steps while the run is active. The next retrieval
uses the latest file. Keep step IDs stable: if you remove the current step, ask the
agent to select an available step explicitly. A missing or invalid file leaves
progress unchanged; restore the file or ask the agent to cancel the run.

Ask the agent to go back when you want to revisit a phase. Going back changes its
position, not your files or previous work. Progress survives context compaction and
provider restarts.

Playbooks operate within one thread. Shared Squadron progression, executable steps,
automatic scheduling, and agent spawning are outside this version.
