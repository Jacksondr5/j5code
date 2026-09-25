# Playbooks

Playbooks give an agent an ordered sequence of prompts. The agent does the work
in its existing thread and decides when to advance. The thread's phase board
shows the current step and whether the run is active, completed, or cancelled.
Earlier steps describe position, not a guarantee that their work passed validation.

Open **Settings → Personas → Playbooks** and select a project or thread worktree to see
its definitions and steps. Playbook Author runs on Codex in the selected workspace.
Choose an authoring Squadron if the project has more than one. It helps shape the
steps, writes the YAML, and checks the definition without starting a run. You can
customize the persona in Settings → Personas. Invalid definitions remain visible
with their errors.

On web and desktop, you can import `.yaml` or `.yml` definitions into the selected workspace. Importing
a file with an existing name asks before replacing it. Changes also apply to runs
using that definition. An active run must be completed or cancelled before its
definition can be deleted; completed run history remains.

On web and desktop, open **Fleet** and use its **Playbook runs** section to follow
runs across your connected environments. The overview shows
each run's owner thread, agent activity, and current step. Select a run to open
its thread, or choose **All** to include completed and cancelled runs.
Unavailable environments keep their last received progress marked as stale.

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

Type `/playbook ` to choose a registered playbook, then send the command to start it.
Send `/playbook` to ask what is available. You can also ask directly: “Start
playbook review.” One playbook can be active per thread;
finishing or cancelling it leaves the agent ready for other work or another playbook.

You can edit prompts and reorder steps while the run is active. The next retrieval
uses the latest file. Keep step IDs stable: if you remove the current step, ask the
agent to select an available step explicitly. A missing or invalid file leaves
progress unchanged; restore the file or ask the agent to cancel the run.

Ask the agent to go back when you want to revisit a phase. Going back changes its
position, not your files or previous work. Progress survives context compaction and
provider restarts. Select an earlier run in the thread to inspect its status.

Each run belongs to one thread. Deleting that thread cancels its active run, so
you can remove the playbook file. Archiving a thread leaves its run available when
you return to it.
