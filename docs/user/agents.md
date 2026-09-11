# Agents

Open **Agents** from a task's right panel to see the runtime agents connected to that task:

- **Direct spawns** are provider-native child agents launched by the task.
- **Workflows** group agents launched together and show their current phase.

The panel reports live status, activity, elapsed time, and token usage. It remains empty until the task launches an agent or workflow.

Agent definitions are separate from runtime activity, so only agents and workflows that have actually launched appear in a task's Agents panel.

The right-panel view is available in the web and desktop clients.

## Starting a task as an agent

In a new task, the composer offers an **Agent** control beside the model picker whenever the selected environment has launchable agents. Choose one and the model and reasoning controls are replaced by the agent's name and its fixed route; use the **×** control to go back to a regular task before sending. On send, the server resolves the agent's route and pins it to the thread, so the thread shows the same agent chip afterwards. If the agent's definition changes later, the chip shows **Changed**; the running task keeps the definition it started with, and a new task uses the current one.

Threads launched as an agent show the agent beside their home in the thread list, and delegated children in the Agents panel show which saved agent ran them.

## Persona library

Open **Settings → Agents** on web, desktop, or mobile to see reusable personas in a connected environment. Select an environment to inspect its library and available model routes. Personas can be authored in folders and shared through git; supplied examples are starting points you can customize.

To create a personal agent without writing a file, use **Create agent** beside **Scoped agents**. Give it a name, a stable ID for `@agent:` mentions, a one-line description, markdown instructions, a runtime policy, and primary and fallback models. The agent is stored in the selected environment as an imported definition, so it can be edited, switched off, or removed like any import. Instructions describe behavior; only the runtime policy is enforced.

To import definitions written as files:

1. Open **Settings → Agents** and select the destination environment.
2. Use **Import** beside **Scoped agents**. Choose **Folder** to include all YAML definitions (`.yaml` or `.yml`) in that folder and its subfolders, or **Import → Agent file** to select one YAML file. Other files are ignored. Each file must contain one agent definition with its own unique ID.
3. The library refreshes after a successful import. Import and removal results appear as temporary toast notifications. A selection can contain up to 50 definitions, each at most 64 KiB. If any definition is invalid, none of the selection is imported; the error identifies the file.

Definitions are YAML files. Use `instructions: |` followed by indented text for multiline instructions. Keep one definition per file; JSON files are not imported.

Definitions are copied from your device into the selected environment, including a remote environment. Later changes to the original files require another import. If any selected agent IDs already exist, a confirmation lists the affected agents. Each conflicting agent has a replacement toggle, initially on. Turn it off to skip importing that agent and keep its current definition. Choose **Import selected** to import new agents and overwrite the selected existing agents, including local edits, or **Cancel** to import nothing. Turning off every replacement still imports any new agents in the selection. Replacement preserves each agent’s on/off setting and existing tasks; future launches use the imported definition. Original source files remain unchanged. If an existing definition changes while confirmation is open, you will be asked to confirm again. Duplicate IDs within the same selection are always rejected.

Each agent shows its availability badge beside its name, an origin badge (**Bundled example**, **Personal** for created or imported agents, or **Folder** with the source folder's name), and a destructive trash icon. Once an agent has launched a task, a usage line appears under its description: tasks, runs, completed and failed counts, the average run time, tokens reported by the provider, and the last launch date. Hover the line (web and desktop) to see which model routes those tasks actually resolved to. The numbers are read from the environment's existing task history whenever Settings opens, so nothing extra is stored. Imported entries also have an **On/Off** switch. New imports start on. Turn an agent off to keep it in the library while preventing new launches; its status changes to **Disabled**. Turn it back on to make it available for activation, subject to its model and runtime-policy requirements. The setting belongs to the selected environment and survives restarts and edits.

Use the trash icon to remove an agent whether it is on or off. Removal deletes its imported copy and excludes any underlying example or folder definition with that ID, so the agent disappears from the library. Running tasks keep their saved definition.

Use the **pencil icon** on an imported or personal agent to edit its **Name**, **Description**, **Instructions**, **Runtime policy**, and **Primary/Fallback models** with their reasoning settings. Each row also has a **more** menu with **Duplicate as personal agent**, which opens the create dialog prefilled from that agent with a fresh ID (the way to build on a bundled example), **Export YAML**, which downloads or shares the definition as a file another environment or teammate can import, and, when more than one environment is connected, **Copy to environment**, which imports the same definition into the environment you pick. Copying uses the ordinary import path, so an existing agent with the same ID in the target asks for confirmation before it is replaced. Open the model menu to see signed-in providers. Hover over a provider to open its models in a side submenu (tap on mobile). Reasoning stays in a separate control showing all options supported by the selected model. Model choices come from the selected environment. Previously configured values are retained until you change them, including unavailable models and other reasoning levels. Save updates only the imported copy and preserves its on/off setting. Cancel discards the draft. Changes affect future launches; the original file and existing tasks stay unchanged. Import a copy first to edit a folder-loaded agent or example. Instructions and the agent ID are not editable in this form.

To invoke an agent in Codex or Claude, type **@** in the composer and select an agent, or type `@agent:<id>` directly. For example: `@agent:scout review the authentication flow`. Available agents come from the current environment. You can remove a selection by deleting its mention before sending.

The selected agent runs as a subagent under the current conversation and returns its result there. It uses its saved instructions, primary/fallback model, reasoning, and runtime policy, even if its model uses a different provider from the parent. It cannot broaden the parent’s permissions. Running subagents keep their saved definition when the library changes. Crews and new-task crew launches are not part of agent invocation.

Persona instructions describe intended behavior. They do not grant permissions or guarantee that an agent obeys them. The displayed runtime policy reflects supported provider controls; unsupported modes appear as **Blocked**.

The trash action also works for folder-loaded agents and bundled examples. Source files remain unchanged, and removal survives restarts. A removed example or folder agent stays in the list marked **Removed** with a **Restore** action that brings it back; a removed imported copy is gone and must be imported again.

### Library sources

The **Library sources** section below the agent list shows the folders the selected environment reads YAML definitions from, whether each folder exists, and how many definition files it holds. Folders are read recursively, so you can point the library at the top of a shared repository and every agent YAML in its subfolders is included, the same way **Import → Folder** works. Choose **Add folder** to browse the environment's own filesystem (not your device's) and pick a folder; you can also type or paste a path in the picker. Remove a folder with its trash icon. Changes are saved to that environment's folder configuration and take effect on the next catalog read. Until you configure a folder, the bundled examples appear whenever the default folder is missing; configuring any folder replaces them with your folders' definitions (duplicate them first if you still want an example).

When a folder lives in a git checkout, the row notes uncommitted changes in that folder and how many commits the remote is ahead. T3 Code only reads git status; commit, push, and pull with your usual tools. On web and desktop an **open in editor** action opens the folder in your preferred editor when one is available on that environment.

The persona library is separate from the task's Agents right panel, which shows runtime activity.

For environment setup, see [Configure a persona library](../operations/persona-library.md).
