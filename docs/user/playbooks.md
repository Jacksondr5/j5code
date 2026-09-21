# Playbooks

Playbooks give an agent an ordered sequence of prompts. The agent does the work
in its existing thread and decides when to advance. The thread's phase board
shows the current step and whether the run is active, completed, or cancelled.
Earlier steps describe position, not a guarantee that their work passed validation.

Open **Settings → Playbooks** and select a project or thread worktree to see its
definitions and phases. On web and desktop, **Create playbook** starts a conversation
with **Playbook Author** in the selected workspace. It asks what you want to accomplish,
helps shape the phases, writes the YAML, and validates it without starting a run.
The persona is added to that environment on first use; customize its instructions
and model in **Settings → Agents**. It currently requires an authenticated Codex
provider because authoring needs Workspace write authority. Mobile prepares an
authoring prompt for you to send instead. Return to the library and refresh after
creation or edits. Invalid definitions remain visible with their errors.
**Prepare playbook chat** opens a draft with a start request in that workspace for you to send.
The command palette also finds the Playbooks settings page.

Use **Import YAML** to add `.yaml` or `.yml` definitions to the selected workspace.
Importing a file with an existing name asks before replacing it. Changes also
apply to runs using that definition.

Open **Playbooks** in the sidebar or **Open playbook runs** in the command palette
to follow agent-led runs across your connected environments. The overview shows
each run's owner thread, agent activity, and current step. Select a run to open
its thread, or choose **All** to include completed and cancelled runs. This
overview contains runs from the agent-led model; earlier playbook history is not
imported. Unavailable environments keep their last received progress marked as stale.

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

Send `/playbook review` to start, or `/playbook` to ask what is available. You can
also ask directly: “Start playbook review.” One playbook can be active per thread;
finishing or cancelling it leaves the agent ready for other work or another playbook.

You can edit prompts and reorder steps while the run is active. The next retrieval
uses the latest file. Keep step IDs stable: if you remove the current step, ask the
agent to select an available step explicitly. A missing or invalid file leaves
progress unchanged; restore the file or ask the agent to cancel the run.

Ask the agent to go back when you want to revisit a phase. Going back changes its
position, not your files or previous work. Progress survives context compaction and
provider restarts. Select an earlier run in the thread to inspect its status.

Playbooks operate within one thread. Shared Squadron progression, executable steps,
automatic scheduling, and agent spawning are outside this version.
