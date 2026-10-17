# Playbooks

Playbooks give an agent an ordered sequence of prompts. The agent does the work
in its existing thread and decides when to advance. The thread's phase board
shows the current step and whether the run is active, completed, or cancelled.
Earlier steps describe position, not a guarantee that their work passed validation.

Open **Settings → Personas** to manage playbooks. New playbooks save to the selected
**Environment library** by default and are available across all its projects and worktrees.
Choose **This workspace only** to keep a procedure in one project's or worktree's
`.j5/playbooks/` folder. Playbook Author runs on Codex in the selected project, helps
shape the steps, and saves the definition without starting a run. A failed save is shown
as an error; a workspace draft is not a shared playbook. You can also paste a finished
definition into **Save YAML** in the environment library, even without a project.

The environment library can read additional folders on that server. Use **Add folder**
to include a folder, and **Remove folder** to stop reading it without deleting its files.
Folder definitions are read-only in the app: edit the source file, or copy it into the
managed environment library. Refresh after changing files outside the app.

A workspace playbook overrides a library playbook with the same name. A broken local
copy shows its error instead of falling back. Two library sources with the same name
must be renamed or one source removed before that name can run. Other playbooks stay
available. Existing workspace files are not published automatically.

On web and desktop, **Import YAML** reads a `.yaml` or `.yml` file from the selected
workspace environment's filesystem. It saves to the environment library by default;
choose **This workspace only** to import locally. The file is saved under a valid
playbook name, so `Release Plan.yaml` becomes `release-plan.yaml`. Environment saves
never replace an existing different definition: choose another name. Workspace imports
ask before replacing an existing file.

**Copy to environment library** shares an existing workspace playbook with the other
projects on that server. It leaves the workspace original in place, so that original
continues to override the shared copy in its own workspace. **Copy to environment**
saves an independent copy on another connected environment. Later edits are separate.
**Export YAML** downloads a definition on web and desktop and shares it from mobile.

For ongoing sharing between machines, keep `personas/` and `playbooks/` in a git
repository and configure each environment to read its local clone's matching folder.
Commit, push, and pull with your usual git tools, then refresh the library. Creating a
playbook does not automatically publish it to other environments.

Runs keep the exact file they started with. Adding a local override or removing a
configured folder does not redirect a running procedure. Changes to that file's contents
still apply live. Complete or cancel active runs before deleting their managed definition;
completed run history remains.

On web and desktop, open **Fleet** and use its **Playbook runs** section to follow
runs across your connected environments. The overview shows
each run's owner thread, agent activity, and current step. Select a run to open
its thread, or choose **All** to include completed and cancelled runs.
Unavailable environments keep their last received progress marked as stale.

Ask your agent to create a playbook in the environment library. For a workspace-only
playbook, save a YAML file under `.j5/playbooks/` in your thread's workspace. The file name is the playbook's name: lowercase letters, digits,
and hyphens, such as `release-review`. The `title` is what you see in the app. A file
with any other name is listed as invalid with a suggested rename. For example,
`.j5/playbooks/review.yaml`:

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
    persona: reviewer
    prompt: Summarize confirmed findings and remaining uncertainty.
```

A step can name the persona that should do it with `persona:`, using a persona id
from Settings → Personas. A step without one is done by whoever runs the playbook.
A persona that is missing or turned off shows as a warning in Settings and does not
stop the playbook from starting.

Type `/playbook ` to choose a registered playbook, then send the command to start it.
Send `/playbook review` to start directly, or `/playbook` to ask what is available.
Text after the name stays part of your message, as in
`/playbook review, then summarize the risks`. You can also ask directly: “Start
playbook review.” One playbook can be active per thread;
finishing or cancelling it leaves the agent ready for other work or another playbook.

Type `@playbook:` anywhere in a message to pick a playbook by name. On its own, the
mention asks the agent to start that playbook in the thread. Invalid playbooks appear in the
list with their error.

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

## With a Crew

A Crew can follow a playbook. Its Captain starts the playbook in its own thread, and
each step goes to the seat that owns it. The Captain moves to the next step after that
seat reports back. Steps no seat owns are the Captain's. Going back or reselecting a
step hands it to its owner again. Fleet shows each Crew's current step and who has it,
or "handing off" while a step is on its way to a seat. Archiving the Crew or its
Captain cancels the run; stopping the Crew doesn't.

To have a crew built from a playbook, ask the crew to use it, with `@playbook:` or by name:

> ok, lets create a crew to implement what we have discussed. Please use @playbook:release for this work.

The agent becomes the Captain, reads the playbook, and proposes one seat per persona the
steps name. A persona that's missing, turned off, or can't run gets a stand-in seat, flagged
on the card.
You approve the roster, and the Captain runs the playbook. This applies only when you ask
the crew to use a playbook; one mentioned in passing starts an ordinary crew.
