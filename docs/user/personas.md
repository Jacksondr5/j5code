# Personas

Open **Agents** from a task's right panel to see the runtime agents connected to that task:

- **Direct spawns** are provider-native child agents launched by the task.
- **Workflows** group agents launched together and show their current phase.

The panel reports live status, activity, elapsed time, and token usage. It remains empty until the task launches an agent or workflow.

Persona definitions are separate from runtime activity, so only agents and workflows that have actually launched appear in a task's Agents panel.

The right-panel view is available in the web and desktop clients.

## Starting a task as a persona

In a new task, the composer offers a **Persona** control beside the model picker whenever the selected environment has launchable personas. Choose one and the model and reasoning controls are replaced by the persona's name and its fixed route; use the **×** control to go back to a regular task before sending. On send, the server resolves the persona's route and pins it to the thread, so the thread shows the same persona chip afterwards. If the persona's definition changes later, the chip shows **Changed**; the running task keeps the definition it started with, and a new task uses the current one.

Threads launched as a persona show the persona beside their home in the thread list, and delegated children in the Agents panel show which persona ran them.

## Persona library

To run a persona inside a conversation, type `@persona:` followed by its ID, or type `@` and the start of the persona's ID or name; matching personas appear above the file results. Choosing one inserts the mention, and the next message runs that persona as a subagent of the conversation.

Open **Settings → Personas** on web, desktop, or mobile to see the reusable personas in a connected environment. Select an environment to inspect its library and available model routes. Personas can be authored in folders and shared through git; supplied examples are starting points you can customize.

To create a personal persona without writing a file, use **Create persona** beside **Scoped personas**. Give it a name, a stable ID for `@persona:` mentions, a one-line description, markdown instructions, a runtime policy, and primary and fallback models. The persona is stored in the selected environment as an imported definition, so it can be edited, switched off, or removed like any import. Instructions describe behavior; only the runtime policy is enforced.

To import definitions written as files:

1. Open **Settings → Personas** and select the destination environment.
2. Use **Import** beside **Scoped personas**. Choose **Folder** to include all YAML definitions (`.yaml` or `.yml`) in that folder and its subfolders, or **Import → Persona file** to select one YAML file. Other files are ignored. Each file must contain one persona definition with its own unique ID.
3. The library refreshes after a successful import. Import and removal results appear as temporary toast notifications. A selection can contain up to 50 definitions, each at most 64 KiB. If any definition is invalid, none of the selection is imported; the error identifies the file.

Definitions are YAML files. Use `instructions: |` followed by indented text for multiline instructions. Keep one definition per file; JSON files are not imported.

Definitions are copied from your device into the selected environment, including a remote environment. Later changes to the original files require another import. If any selected persona IDs already exist, a confirmation lists the affected personas. Each conflicting persona has a replacement toggle, initially on. Turn it off to skip importing that persona and keep its current definition. Choose **Import selected** to import new personas and overwrite the selected existing personas, including local edits, or **Cancel** to import nothing. Turning off every replacement still imports any new personas in the selection. Replacement preserves each persona’s on/off setting and existing tasks; future launches use the imported definition. Original source files remain unchanged. If an existing definition changes while confirmation is open, you will be asked to confirm again. Duplicate IDs within the same selection are always rejected.

Each persona shows its availability badge beside its name (hover a **Blocked** badge on web or desktop, or read the lines under the description on mobile, to see which route failed and why: a model the signed-in provider does not offer, a provider that is not signed in, or a runtime policy that is not enforceable yet), an origin badge (**Bundled example**, **Personal** for created or imported personas, or **Folder** with the source folder's name), and a destructive trash icon. Once a persona has launched a task, a usage line appears under its description: tasks, runs, completed and failed counts, the average run time, tokens reported by the provider, and the last launch date. Hover the line (web and desktop) to see which model routes those tasks actually resolved to. The numbers are read from the environment's existing task history whenever Settings opens, so nothing extra is stored. Every listed persona has an **On/Off** switch, including bundled examples and folder personas. New imports start on. Turn a persona off to keep it in the library while preventing new launches; its status changes to **Disabled**. Turn it back on to make it available for activation, subject to its model and runtime-policy requirements. The setting belongs to the selected environment and survives restarts and edits; switching off a folder or bundled persona never touches its file.

Use the trash icon to remove a persona whether it is on or off. Removal deletes its imported copy and excludes any underlying example or folder definition with that ID, so the persona disappears from the library. Running tasks keep their saved definition.

Use the **pencil icon** on an imported or personal persona to edit its **Name**, **Description**, **Instructions**, **Runtime policy**, and **Primary/Fallback models** with their reasoning settings. Each row also has a **more** menu with **Duplicate as personal persona**, which opens the create dialog prefilled from that persona with a fresh ID (the way to build on a bundled example), **Export YAML**, which downloads or shares the definition as a file another environment or teammate can import, and, when more than one environment is connected, **Copy to environment**, which imports the same definition into the environment you pick. Copying uses the ordinary import path, so an existing persona with the same ID in the target asks for confirmation before it is replaced. Open the model menu to see signed-in providers. Hover over a provider to open its models in a side submenu (tap on mobile). Reasoning stays in a separate control showing all options supported by the selected model. Model choices come from the selected environment. Previously configured values are retained until you change them, including unavailable models and other reasoning levels. Save updates only the imported copy and preserves its on/off setting. Cancel discards the draft. Changes affect future launches; the original file and existing tasks stay unchanged. Import a copy first to edit a folder-loaded persona or example. Instructions and the persona ID are not editable in this form.

To invoke a persona in Codex or Claude, type **@** in the composer and select a persona, or type `@persona:<id>` directly. For example: `@persona:scout review the authentication flow`. Available personas come from the current environment. You can remove a selection by deleting its mention before sending.

The selected persona runs as a subagent under the current conversation and returns its result there. It uses its saved instructions, primary/fallback model, reasoning, and runtime policy, even if its model uses a different provider from the parent. It cannot broaden the parent’s permissions. Running subagents keep their saved definition when the library changes. Crews and new-task crew launches are not part of persona invocation.

An agent can also start a persona as a peer with its own top-level task by naming it in a spawn. The peer keeps the persona's instructions and runtime policy, and the spawning agent must choose one of the persona's declared provider, model, and reasoning combinations. The peer runs with its own persona's permissions, not the spawning agent's.

## Crews

A crew is a group of agents that one agent, the Captain, runs as a unit for one piece of work. You do not define crews in advance, and there is no special Captain agent: any thread can compose a crew. On web or desktop, in a new or existing thread, type `/` and pick **/crew** from the menu (or type it), then add what the crew should accomplish, for example:

```text
/crew Follow @docs/runbooks/release.md for the 2.4 release and report back when the PR is green.
```

The thread's agent, whichever persona or model it is running as, receives your brief together with instructions to compose a crew rather than do the work itself. It reads the persona library and proposes a roster: one seat per persona with a reason. The proposal appears above the composer in that thread, like a planning question. Remove seats you do not want, or add a seat: pick **Custom seat** and give it a name and instructions for a seat with no persona behind it (instructions are required; it runs on the Captain's provider and model with the Captain's access mode, not a persona's sandbox), or pick a persona from the library and add instructions if it needs them. Then **Approve** or **Decline**. Approval starts every seat as a peer under the Captain with your brief and the roster, and the Captain is told the decision in its thread, where it shows as a card listing the crew and its seats; click a seat to open its thread. Your `/crew` message shows as the brief you wrote, with the instructions the command sent alongside it one click away. Seats run with their own persona's permissions once you approve them, so a read-only Captain can command agents that write.

One Captain can run several crews. Send `/crew` again in the same thread when there is separate work to hand off, and each proposal gets its own named crew; the Captain can also propose another crew on its own when the work splits.

While the crew works, the Captain may ask for one more seat. That request lands under **Crew requests** in the Inbox and counts on the inbox bell; approve or decline it there. A crew holds at most twelve seats. Crew members cannot request seats themselves.

When a seat's persona is defined to return a report, such as a review handoff, it writes that report as a handoff artifact under `handoffs/` in the project's Artifacts page, exactly as the persona would when running on its own (see **Handoff artifacts** above). When a seat first finishes, and again whenever its result or report changes, the Captain gets a notice in its thread, shown as a card with the seat's result and its report, which opens in the artifacts panel and can be read inline when it is short; notices that arrive while the Captain is mid-turn are combined into one card. A seat that finishes without writing its report is reminded once, and the notice says the report is missing. Reports are never left in chat.

Crews are a web and desktop feature; the mobile app shows crew members as ordinary agents and has no roster gate. Members stay out of the thread list so it shows the conversations you started; the Captain's row shows an anchor mark (hover it for the crews it commands) and, for each crew it runs, a toggle named for that crew that opens into its members with seat, status, and last activity; agents it started outside a crew get a toggle of their own. When a member finishes and owes no reply, the Captain is told how it ended; the member's thread settles under the same rules as any other thread. **Fleet**, from the icon beside the inbox bell, shows every agent by Squadron with each crew under its Captain.

To stop a crew that is heading the wrong way, use **Stop crew** on the crew's row in Fleet or the small **Stop** beside that crew's toggle under the Captain in the thread list; both appear only while a member is running. Stopping interrupts every running member's turn and nothing else: members stay on the roster and can be messaged again. The Captain can do the same from its own tools.

A crew is retired as a unit, by the Captain or by you. The Captain is shown exactly what will end, seat by seat, and asked to confirm; the guidance is to check with you first. You can retire a crew yourself with **Archive crew** on its row in Fleet, and archiving a Captain's thread retires its crews with it; from the thread list, a dialog first lists every member with any running turn or open ask. Individual crew members cannot be archived or deleted on their own, from any device. Archiving never deletes worktrees, branches, or conversation history, and a retired crew's brief and roster stay readable under **Retired crews** at the bottom of its Squadron in Fleet.

Persona instructions describe intended behavior. They do not grant permissions or guarantee that an agent obeys them. The displayed runtime policy reflects supported provider controls; unsupported modes appear as **Blocked**.

The trash action also works for folder-loaded personas and bundled examples. Source files remain unchanged, and removal survives restarts. A removed example or folder persona stays in the list marked **Removed** with a **Restore** action that brings it back; a removed imported copy is gone and must be imported again.

### Library sources

The **Library sources** section below the persona list shows the folders the selected environment reads YAML definitions from, whether each folder exists, and how many definition files it holds. Folders are read recursively, so you can point the library at the top of a shared repository and every persona YAML in its subfolders is included, the same way **Import → Folder** works. Choose **Add folder** to browse the environment's own filesystem (not your device's) and pick a folder; you can also type or paste a path in the picker. Remove a folder with its trash icon. Changes are saved to that environment's folder configuration and take effect on the next catalog read. Until you configure a folder, the row for the default `personas` folder reads **Default · not created; bundled examples in use**, and the bundled examples appear in the library; configuring any folder replaces them with your folders' definitions (duplicate them first if you still want an example).

When a folder lives in a git checkout, the row notes uncommitted changes in that folder and how many commits the remote is ahead. T3 Code only reads git status; commit, push, and pull with your usual tools. On web and desktop an **open in editor** action opens the folder in your preferred editor when one is available on that environment.

### Handoff artifacts

A persona whose definition declares an output artifact (for example the bundled Critic's `ReviewHandoff`) writes it as a shared project artifact instead of leaving it in the transcript. The persona's instructions name the exact file, `handoffs/<persona>/<Artifact>-<task>.md` under the project's artifacts, and the required contents. When a run ends without that file, the agent is asked once to write it. The reminder runs as a follow-up in the agent's own task; the task that delegated the work is told the agent finished as usual and is not held back. If the follow-up also ends without the file, the handoff is recorded as **missing**, no further reminder is sent, and the task should be treated as incomplete. Rewriting a handoff does not replace it: each rewrite adds a version to the top of the same file, so you can compare a revised review with the earlier one on the Artifacts page.

The task's persona control (web, desktop, and mobile) and its row in the Agents right panel show the handoff status: the artifact name when written, **pending** after the reminder, or **missing**. On web and desktop the chip opens the file in the Artifacts page. Declared input artifacts are read the same way, so a Builder started after a Navigator finds the `PlanHandoff` under `handoffs/`.

The persona library is separate from the task's Agents right panel, which shows runtime activity.

For environment setup, see [Configure a persona library](../operations/persona-library.md).
