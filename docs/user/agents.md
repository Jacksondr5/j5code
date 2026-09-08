# Agents

Open **Agents** from a task's right panel to see the runtime agents connected to that task:

- **Direct spawns** are provider-native child agents launched by the task.
- **Workflows** group agents launched together and show their current phase.

The panel reports live status, activity, elapsed time, and token usage. It remains empty until the task launches an agent or workflow.

Agent definitions are separate from runtime activity, so only agents and workflows that have actually launched appear in a task's Agents panel.

The right-panel view is available in the web and desktop clients.

## Persona library

Open **Settings → Agents** on web, desktop, or mobile to see reusable personas in a connected environment. Select an environment to inspect its library and available model routes. Personas can be authored in folders and shared through git; supplied examples are starting points you can customize.

To add your own definitions:

1. Open **Settings → Agents** and select the destination environment.
2. Use **Import** beside **Scoped agents**. Choose **Folder** to include all JSON and YAML definitions in that folder and its subfolders, or **Import → Agent file** to select one `.json`, `.yaml`, or `.yml` file. Other files are ignored. Each file must contain one agent definition with its own unique ID.
3. The library refreshes after a successful import. Import and removal results appear as temporary toast notifications. A selection can contain up to 50 definitions, each at most 64 KiB. If any definition is invalid, none of the selection is imported; the error identifies the file.

YAML is convenient for writing multiline instructions without escaped line breaks. Use `instructions: |` followed by indented text. JSON and YAML use the same fields and validation. Keep one definition per file and avoid keeping both formats for the same agent in an imported folder.

Definitions are copied from your device into the selected environment, including a remote environment. Later changes to the original files require another import. If any selected agent IDs already exist, a confirmation lists the affected agents. Each conflicting agent has a replacement toggle, initially on. Turn it off to skip importing that agent and keep its current definition. Choose **Import selected** to import new agents and overwrite the selected existing agents, including local edits, or **Cancel** to import nothing. Turning off every replacement still imports any new agents in the selection. Replacement preserves each agent’s on/off setting and existing tasks; future launches use the imported definition. Original source files remain unchanged. If an existing definition changes while confirmation is open, you will be asked to confirm again. Duplicate IDs within the same selection are always rejected.

Each agent shows its availability badge beside its name and a destructive trash icon. Imported entries also have an **On/Off** switch. New imports start on. Turn an agent off to keep it in the library while preventing new launches; its status changes to **Disabled**. Turn it back on to make it available for activation, subject to its model and runtime-policy requirements. The setting belongs to the selected environment and survives restarts and edits.

Use the trash icon to remove an agent whether it is on or off. Removal deletes its imported copy and excludes any underlying example or folder definition with that ID, so the agent disappears from the library. Running tasks keep their saved definition.

Use the **pencil icon** on an imported agent to edit its **Name**, **Description**, **Runtime policy**, and **Primary/Fallback models** with their reasoning settings. Open the model menu to see signed-in providers. Hover over a provider to open its models in a side submenu (tap on mobile). Reasoning stays in a separate control, limited to the model’s supported **low**, **medium**, and **high** levels. Model choices come from the selected environment. Previously configured values are retained until you change them, including unavailable models and other reasoning levels. Save updates only the imported copy and preserves its on/off setting. Cancel discards the draft. Changes affect future launches; the original file and existing tasks stay unchanged. Import a copy first to edit a folder-loaded agent or example. Instructions and the agent ID are not editable in this form.

Orchestrators activate personas in this version. Selecting a persona directly when creating a task is planned. A task keeps the definition and model route it launched with, even when the library changes.

Persona instructions describe intended behavior. They do not grant permissions or guarantee that an agent obeys them. The displayed runtime policy reflects supported provider controls; unsupported modes appear as **Blocked**.

The trash action also works for folder-loaded agents and bundled examples. Source files remain unchanged, and removal survives restarts. To restore an agent, use **Import → Agent file** and select its original definition file.

The persona library is separate from the task's Agents right panel, which shows runtime activity.

For environment setup, see [Configure a persona library](../operations/persona-library.md).
