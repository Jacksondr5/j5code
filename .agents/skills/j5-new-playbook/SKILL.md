---
name: j5-new-playbook
description: Use when a user requests a "new playbook", "create playbook", "playbook yaml", "t3-playbook", or "playbook definition" in a j5code checkout.
---

# New J5 Playbook

Create a Playbook YAML definition and verify it with the checkout's real compiler. Keep authoring rules limited to its schema and validation.

## 1. Preconditions

Check that cwd is a j5code checkout containing `apps/server/src/j5/playbook-definitions/Yaml.ts`. If missing, stop before writing: "Wrong branch or checkout: apps/server/src/j5/playbook-definitions/Yaml.ts is missing. Use the PR 114 branch codex/pr114-workflow-optimization or a checkout containing its merged validator."

## 2. Gather inputs

Use information already supplied. Ask one question at a time, only for missing information: goal, ordered phases, each phase's kind (`agent`, `code`, or `gate`), personas per agent task, loopbacks and visit limits, and output path.

Default the output to `<stateDir>/playbooks/<id>.yaml`, or use the user's named path. Resolve the intended environment's actual `stateDir` from its configuration. Ask if it remains unknown. Derive a descriptive id and name from the goal and use version 1 for a new definition. Resolve the output to an absolute path before validation.

## 3. Templates

Read and adapt the applicable shipped example:

- Agent and gate phases: `apps/server/src/j5/playbook-definitions/research-review.yaml`.
- Code tasks (`workspace`, `validation`, `commit`, `push`, `draft`): `apps/server/src/j5/playbook-definitions/fh/development.yaml`.

Copy their YAML structure. The development example declares a registered `implementation`, which bypasses ordinary phase compilation. Copy its code-task shapes only, omit `implementation`, and use the transition keys and outcome rules below for generic YAML phases.

## 4. Rules

Use `Yaml.ts` as the authority if the checkout differs from this reference. Its final `validateDefinition` call also checks phase and task identity and graph reachability.

- Set `schema: t3-playbook/v1`, nonempty `id`, `name`, `description`, and `initial` (a declared phase id), integer `version >= 1`, optional `agents`, and a nonempty `phases` list. Omit `implementation`.
- Define `agents.<name>` as `{ persona, authority }`. Require a nonempty persona. The current imported authority schema accepts `read-only`, `critic-review`, `workspace-write`, `critic-fix`, `diagnostic`, and `publish-only`.
- Give every phase a unique nonempty `id`, `kind: agent|code|gate`, and a `transitions` map. Reserve `__workspace` for the compiler-generated phase. Make every authored phase reachable from `initial`.
- Allow optional nonempty `label`, `tasks`, integer `visitLimit >= 1` (default 1), `outcome: completion|review|validation` (default completion), and `evidence`, `approvals`, `capabilities` arrays of nonempty strings.
- Make evidence entries reference a phase id or `__workspace`. Make approvals entries reference a gate phase id. Make transition targets reference a phase id or `$complete`.

| Phase kind | Allowed transition keys                                      |
| ---------- | ------------------------------------------------------------ |
| gate       | `approve`, `request_changes`, `changed`                      |
| agent      | `completed`, `changed`; also `revise` with `outcome: review` |
| code       | `pass`, `changed`; also `revise` with `outcome: validation`  |

- Use `changed` for invalidation. Omit tasks and outcome from gates. Exact diagnostics include "gates cannot have tasks" and "gates cannot declare outcome aggregation".
- Give agent and code phases at least one task. Give every task a nonempty id, unique within its phase.
- For each agent task, "set exactly one of agent or persona". Resolve named agents from `agents`. For inline personas, optionally set authority (default `read-only`). Supply nonempty `instructions` and `output: report|review`: "agent tasks require instructions and output". Schedule the same named agent at most once per phase.
- Set `outcome: review` only on an agent phase whose tasks all use `output: review`: "review aggregation requires agent tasks with review output".
- For code tasks, set `operation: workspace|validation|repair_capacity|metadata|commit|push|draft` and omit agent/persona: "code tasks require one registered operation".
- Set `outcome: validation` only on a code phase with operation `validation` in its first task: "validation aggregation requires validation as the first code task".
- Set `visitLimit >= 2` on every phase that needs revisiting, including intermediate phases in a loop. Choose limits for the requested number of visits. The compiler accepts a loop with limit 1, but that phase cannot run a second time.
- Write YAML 1.2 with unique mapping keys and no aliases or anchors.

## 5. Validate

Write the requested YAML. From the checkout's `apps/server` directory, run this command with the actual absolute output path quoted:

```bash
node --experimental-strip-types -e 'import("./src/j5/playbook-definitions/Yaml.ts").then(m=>{m.compileYamlPlaybook(require("fs").readFileSync(process.argv[1],"utf8"),process.argv[1]);console.log("OK")}).catch(e=>{console.error(e.message);process.exit(1)})' '/abs/path/to/new.yaml'
```

Read each `file:field: message` diagnostic, fix the named field, and rerun until exit status 0 and `OK`. For example, `phases.approval.transitions.completed: outcome completed is not valid for this gate phase` requires a valid gate outcome key. Schema errors can identify `$`, and graph errors can identify `phases`.

If Node or dependency loading prevents compilation, report that blocker and leave validation explicitly incomplete. A checklist or YAML parser alone does not establish success.

## 6. Report

Print the absolute file path and the compiler result. Explain import via **Settings → Playbooks → Import YAML**, or placement in `<stateDir>/playbooks/`. State that the persona library must contain every persona named. Compile success verifies the definition, not persona availability or execution. Do not invoke a running server's import API.
