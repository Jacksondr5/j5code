# Playbooks

Playbooks give an agent an ordered sequence of prompts. The agent does the work
in its existing thread and decides when to advance. The progress bar above the
chat box shows the current step’s position and title. This is recorded progress,
not proof that earlier work passed. Expand it to see the full procedure and who
holds the step. **Waiting for approval** means the run has an open checkpoint;
**Blocked** means its owner has another open ask to a person. Everyone viewing the
thread sees these labels, even when someone else must answer.
On the phone, the playbook card appears while a run is active.

Open **Settings → Agent Setup** to manage playbooks. Playbooks in the environment
library are available across all projects and worktrees on its environment. Choose
**Create playbook** to work with Playbook Author, or **Import YAML** to add a finished
definition without a project. A project chosen for an authoring or playbook
conversation only determines where that conversation opens. On mobile, both open a
new chat: pick the project from its heading, then send.

On web and desktop, import a YAML file from your device or paste its contents. On
mobile, paste the YAML. Names use lowercase letters, digits, and hyphens, so
`Release Plan.yaml` becomes `release-plan.yaml`. Imports never replace a different
existing definition: choose another name instead. **Export YAML** downloads the
definition on web and desktop and shares it from mobile.

The library can read additional folders on the environment's machine. Add a source
folder through the library's actions menu. Removing a source stops reading it
without deleting its files. Folder definitions are read-only in the app: edit the
source file, or copy it into the managed library. Refresh after changing files
outside the app. Duplicate names across sources show an error until a copy is
renamed or a source is removed.

A project can also keep playbooks in its own `.j5/playbooks/` folder, committed with
its code. They are available only in that project and its worktrees, and override a
library playbook with the same name there. To see them in Settings, pick the project
in the **Project** menu above the list. **Copy to library** makes one available
everywhere.

**Copy to environment** saves an independent copy on another connected environment.
For ongoing sharing between machines, keep `personas/` and `playbooks/` in a git
repository and configure each environment to read its local clone's matching folder.
Commit, push, and pull with your usual git tools, then refresh the library. Creating a
playbook does not automatically publish it to other environments.

Runs keep a copy of the procedure they started with. Editing or deleting a saved
playbook affects future runs only. Existing runs continue from their copy, and
completed or cancelled runs remain in history. Older runs that predate saved copies
show their last recorded step and any cancellation reason without a step list.

On web and desktop, open **Fleet** and use its **Playbook runs** section to follow
runs across your connected environments. The overview shows
each run's owner thread, agent activity, and current step. Select a run to open
its thread, or choose **All** to include completed and cancelled runs.
Unavailable environments keep their last received progress marked as stale.

Ask your agent to create or change a playbook. It saves to the environment library
unless you ask for a project-only playbook, which it writes to `.j5/playbooks/` in that
project. The playbook's name uses lowercase letters, digits, and hyphens, such as
`release-review`. The `title` is what you see in the app. For example, import this
definition as `review`, or save it as `.j5/playbooks/review.yaml`:

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
from Settings → Agent Setup. A step without one is done by whoever runs the playbook.
Missing, turned-off, or unverified personas show as warnings in Settings and do not
stop the playbook from starting. Invalid persona files leave absent personas unverified;
fix the files reported in Settings → Agent Setup before treating them as missing.

Add `approval: required` to a step when each run needs a person's sign-off before moving on. The owner submits a summary of the finished work when it tries to leave. One request appears in the Inbox and the owner's chat on web and desktop; answering either updates both on connected devices. Owners and Collaborators who can write to the owner thread may approve or decline. Viewers can read the submitted summary in the owner thread’s expanded playbook progress. Choose **Approve** or **Decline**. You can include a reason when declining, which returns to the owner; the run stays on that step until a new request is approved. Answered checkpoints appear in the Inbox’s Answered list. Use web or desktop to answer.

Approval permits the owner's next move; it does not move the run automatically or replace Crew, persona, or tool permissions. Going back onto an approved step asks again. Revisions must keep each required checkpoint and its step ID. Submitting a different summary opens a fresh request. Changing that step's saved work invalidates its approval; changing only its holder does not. Cancelling the run or removing its owner closes any pending request. A one-off “show me first” can remain an instruction to the agent without changing the reusable playbook.

Type `/playbook ` to choose a registered playbook, then send the command to start it.
Send `/playbook review` to start directly, or `/playbook` to ask what is available.
Text after the name stays part of your message, as in
`/playbook review, then summarize the risks`. You can also ask directly: “Start
playbook review.” One playbook can be active per thread;
finishing or cancelling it leaves the agent ready for other work or another playbook.

Type `@playbook:` anywhere in a message to pick a playbook by name. On its own, the
mention asks the agent to start that playbook in the thread. Invalid playbooks appear in the
list with their error.

Editing prompts or reordering steps in a saved playbook changes the procedure for
future runs. The current run keeps the copy it started with, even if the saved
playbook is deleted.

To change a procedure already running, ask its agent to revise the run: for example,
“Remove the deployment step from this run” or “Add a review step before reporting.”
The agent can also propose a change for you to approve. The change applies only to
this run; editing the reusable playbook is separate. If the change removes the
current step, name the step to continue on; the owner can assign that replacement
to an eligible agent or keep it. A change that keeps the current step also keeps
its holder. Run history shows how many revisions were made and whether the latest
was requested or approved.

Ask the agent to go back when you want to revisit a phase. Going back changes its
position, not your files or previous work. Progress survives context compaction and
provider restarts. Expand the playbook above the chat box to see its stages or
select an earlier run. The stage list marks the recorded position, including when the agent goes back.

Cancelling a run stops its current holder when that is another agent. The owner stays available, and work, artifacts, conversations, Crew, and workspaces remain. If Stop fails, the run still ends and the result gives a reason; retrying cancellation does not stop again.

Each run belongs to one thread. Archiving or deleting that thread cancels its active run. You can remove the playbook file at any time because each run keeps its own copy.

## Assigning steps

The agent that starts a playbook owns its run and advances the steps. It can name an eligible Peer Agent or a member of a Crew it captains as the holder when starting, moving forward, or going back. That agent receives the current step's saved instructions in its thread. The owner can also assign the current step to someone else or take it back without changing the step. A Crew seat does not automatically own a step.

Fleet shows the run beside its owner and names the current holder. “Handing off” means the step notice has not reached that holder yet; the owner can reassign or take back a stuck hand-off. The owner advances after the holder reports back. Archiving a holder does not change the recorded assignment or move the run.

Unarchiving the owner does not reopen a cancelled run. Archiving only its Crew leaves the run active; the owner can reassign an archived holder or take the step back. Continue after an interruption resumes the same run, step, holder, and saved procedure.
