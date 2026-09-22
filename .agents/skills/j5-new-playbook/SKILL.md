---
name: j5-new-playbook
description: Create or refine an agent-led J5 playbook in .j5/playbooks, with ordered prompts and stable step IDs. Use when asked to create a playbook or edit its phases.
---

# Create a playbook

Write a live prompt sequence for the agent in the current thread workspace.
Use the user's goal and constraints; ask for the goal if missing. Each phase's
prompt should state the work, the evidence or output expected, and when to advance.

Save `.j5/playbooks/<name>.yaml` in the thread's current workspace, including when
the thread uses a worktree. Inspect existing definitions before choosing a name;
preserve existing files unless the user asked to edit them.

Use this format:

```yaml
title: Review a change
description: Understand the change, inspect it, and report findings.
steps:
  - id: understand
    title: Understand
    prompt: Read the change and describe its intended behavior before advancing.
  - id: inspect
    title: Inspect
    prompt: Check correctness and run relevant checks. Record evidence for findings.
  - id: report
    title: Report
    prompt: Summarize confirmed findings and remaining uncertainty, then complete the playbook.
```

Keep every field nonempty and every step ID unique. Preserve IDs when refining or
reordering existing steps: active runs track identity by ID. Use 1–100 steps, YAML
1.2 without aliases, and a file no larger than 256 KiB. Express tasks as prompts
for the same agent. This format has ordered steps; executable phases, personas,
transition graphs, and the older `t3-playbook/v1` schema belong to a different engine.

After writing, call `playbook_list` in the same thread. Fix any reported issue and
repeat until the named definition is valid. This validates through the runtime's
live reader without starting a run. If that tool is unavailable, report validation
as incomplete rather than claiming parser-only checks prove runtime acceptance.

Report the file, purpose, and phases. Explain that Settings → Playbooks shows the
definition after selecting its workspace and refreshing, and `/playbook <name>`
starts it. Create or refine only; start a run when the user requests execution.
