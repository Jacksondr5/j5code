---
title: "Agent persona definition contract"
kind: spec
status: 1
---

# Agent persona definition contract

A **persona** is the current implementation of a user-authored [Role](../features/roles.md), not a second product concept. The library contains only user-authored definitions. The historical examples below describe legacy assignments; they are not added to the catalog.

## Delivery boundary

PR #75 defines the contract. Runtime delivery belongs to the dependent PRs; neither this document nor the backlog claims that the stack is merged or that every planned Role capability is complete.

This revision delivers folder discovery, definition validation, configurable definitions and instructions, environment-specific routing, immutable launch snapshots, and Settings folder/single-agent import across web, desktop, and mobile. Existing orchestrators remain responsible for activation, and a person can also choose a persona in the new-task composer on web, desktop, and mobile. Instruction editing, Role-library git controls, skill allowlists, posture controls, and drift indicators are follow-up work. The Roles feature document retains that long-term direction and labels these delivery limits explicitly.

Crew composition, Playbook steps, workflow gates, and lifecycle automation remain separate features. A persona file describes the agent; the per-task brief still supplies the work.

## User-authored library

- Settings → Agent Setup offers **Create persona**, which authors a personal persona (name, stable ID, description, markdown instructions, access level, an ordered model list) and stores it as an imported definition of the selected environment; the server supplies the remaining contract fields. It also offers one **Import** menu with **Persona file** (one YAML definition) and **Folder** (all YAML definitions, including subfolders). The selected files are copied into the selected environment, so the same flow works remotely. Up to 50 files of 64 KiB each are validated as one atomic batch.
- Imported agents can be edited in Settings: name, description, instructions, access level, and ordered model entries with reasoning settings. Any listed agent, including removed folder sources, can be duplicated into a personal agent or exported as YAML. Changes apply only to the imported copy and future launches, preserve enabled state, and reject stale concurrent edits.
- Every listed agent has an environment-local **On/Off** setting, including folder definitions. New imports start enabled; disabling prevents new launches and keeps the entry visible. Replacement imports preserve the setting; removing an import clears it. Source ids are disabled through a separate state file that never touches their files. Running tasks retain their snapshots.
- UI imports show a confirmation for existing IDs: each conflicting agent has a replacement toggle. Cancel imports nothing; Import selected imports new agents and overwrites only the selected existing definitions, including local edits, while preserving enabled state and saved tasks. Toggled-off agents are skipped throughout the import. New or changed conflicts require fresh confirmation. Duplicate IDs within a selection fail the batch. The trash action removes the imported copy and excludes any underlying source definition, without altering running tasks. Removed source definitions stay listed as **Removed** with a **Restore** action, so removal from Settings is reversible without any file. Source edits require reimporting unless the server reads that folder directly through configuration.
- A library combines imported copies with optional source folders on the selected environment's filesystem. Definitions are plain YAML files with markdown instruction content, editable and shareable through ordinary editors and git. Git is optional. Loading never clones, pulls, pushes, or executes a file.
- For directly configured source folders, each `.yaml` or `.yml` file in the folder tree holds one definition; subfolders are walked recursively in sorted order (dot-directories such as `.git` are skipped), matching the import picker. JSON and other file types are ignored there and JSON is rejected on import. Configuration selects folders explicitly; order is preserved and filenames are sorted. Duplicate ids fail the library read rather than silently choosing a winner.
- The default library folder is `personas` below the environment's state directory. An absent default folder, an existing empty folder, or an explicit empty folder list yields no source definitions; imports remain available. No bundled personas are added, and former example IDs are available for user-authored definitions.
- `<stateDir>/agent-personas.json` accepts `{ "folders": ["personas", "/absolute/team-library"] }`. Relative paths resolve from that environment's state directory. Configuration and source files are re-read at catalog requests and new activations; no restart or continuous watcher is required. Reopening Settings reads the library again. Settings → Agent Setup → **Library sources** lists and edits this file through J5 RPCs, shows each folder's existence and definition count, and, for folders inside a git checkout, the two permitted nudges (uncommitted changes, remote ahead) plus an open-in-editor action on web/desktop. The server only reads `git status`; it never fetches, pulls, or commits.
- Every new catalog entry carries an `origin` (`imported` or `folder` with the source file path), shown as a badge. Clients retain the legacy `bundled` origin for compatibility with older environments. A per-agent usage line (tasks, runs, completed/failed, mean completed-run duration, provider-reported tokens, last launch, resolved routes) is aggregated from existing thread, run, and provider-turn projections on request through `getAgentPersonaUsage`; nothing new is persisted.
- **Copy to environment** in a row's more menu reads the agent's YAML from the selected environment and imports it into another connected environment with the ordinary conflict confirmation; personal agents therefore stay environment-local by default and travel only on request.
- Invalid source files are excluded individually; Settings → Agent Setup and `j5_list_personas` report their paths and validation reasons while valid personas remain available. Missing configured folders, malformed configuration, and duplicate ids produce a library error. A launch of an unavailable persona fails before thread creation. No missing or invalid source silently adds example personas.
- Source and imported definitions use the same validation. Historical definitions remain available only for resolving legacy assignments without snapshots; they do not populate the library or reserve IDs.

## Definition format

Each definition has:

| Field                                                  | Meaning                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                                   | Stable lowercase slug, such as `team-researcher`. Custom ids require no code changes.                                                                        |
| `version`                                              | Positive integer chosen by the author. Changing it communicates a revision; content is also fingerprinted, so same-version edits are detected at launch.     |
| `displayName`, `description`                           | Human-facing identity and a concise purpose.                                                                                                                 |
| `instructions`                                         | Nonempty markdown identity and operating principles, at most 32,768 characters. The spawner supplies the task brief separately.                              |
| `acceptedInput`                                        | Optional human-readable input summary; ordinary prompts and supporting evidence are allowed.                                                                 |
| `inputArtifacts`, `outputArtifact`, `artifacts`        | Retired. A definition that still carries them loads, and they are ignored; they stay part of the content fingerprint so stored snapshots keep their digests. |
| `access`                                               | One of `read-only`, `workspace-write`, or `full-access`. Mutually exclusive with legacy `authority`.                                                         |
| `authority.defaultPolicy`, `authority.allowedPolicies` | Legacy storage. New launches map the default to one access level; the former allowed list grants no additional access.                                       |
| `modelRoute`                                           | A nonempty ordered list. Entries accept legacy `driver`/`model`/`reasoningEffort` or `instanceId`/`model`/`options`.                                         |

Files are limited to 64 KiB. Reading a definition never rewrites it. Legacy artifact values remain in stored identity but do not affect behavior. Snapshot digests are checked against their stored JSON bytes before decoding, so upgrades preserve running workers without migrating their snapshots.

New launches map `critic-review` to read-only and `critic-fix` to workspace-write; diagnostic and publication-only defaults are invalid, with a repair message naming the three supported levels. An unsupported policy only in the retired allowed list is ignored. Existing assignments retain their saved policy and human-approved runtime override. A legacy reviewer with an allowed fix policy therefore remains read-only for new launches, while its existing fix workers continue with their saved workspace access.

Read responses keep legacy authority and two-target summaries alongside the complete model list and access. A one-entry list repeats its entry only in that summary. Unavailable catalog entries omit legacy attempts; current clients read per-entry diagnostics from additive modelEntries. Older clients can read personas and continue tasks; the server withholds legacy edit metadata and rejects edits that would truncate a new definition. The legacy summary labels an absent provider as unconfigured and an unspecified reasoning option as Provider default; these labels are never execution selections. The full YAML export preserves the stored definition. Ordered-list editors use additive edit metadata and an explicit format marker so legacy clients cannot truncate a newer definition. Create and edit writes require an updated client and carry one access level.

## Historical examples

These examples document historical assignments and are not selectable unless a user authors or imports a definition. Their operating instructions describe intended behavior, including no-commit or no-merge expectations; those words do not themselves enforce permissions.

| ID             | Display name | Description                                                         | Accepted input                                            | Authority                       | Primary route            | Secondary route           |
| -------------- | ------------ | ------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------- | ------------------------ | ------------------------- |
| `scout`        | Scout        | Collects cited evidence into a Context Brief. Read-only.            | Evidence request or prompt                                | `read-only`                     | `gpt-5.6-terra`, high    | `claude-opus-5`, high     |
| `navigator`    | Navigator    | Turns a Context Brief into an implementation plan. Read-only.       | `ContextBrief`                                            | `read-only`                     | `gpt-5.6-sol`, high      | `claude-fable-5-1`, high  |
| `advocate`     | Advocate     | Checks a plan against product and design requirements.              | `PlanHandoff` plus Jira, Confluence, or Figma evidence    | `read-only`                     | `claude-sonnet-5`, high  | `gpt-5.6-terra`, high     |
| `skeptic`      | Skeptic      | Stress-tests a plan for feasibility, risk, and hidden scope.        | `PlanHandoff` plus repository evidence                    | `read-only`                     | `claude-opus-5`, high    | `gpt-5.6-terra`, high     |
| `builder`      | Builder      | Implements an approved handoff. Never commits or pushes.            | `PlanHandoff`, `DiagnosisHandoff`, or `ReviewInbox`       | `workspace-write`               | `gpt-5.6-sol`, high      | `claude-opus-5`, high     |
| `critic`       | Critic       | Reviews implementation; Fix Mode may apply targeted fixes.          | `CodeCompleteHandoff` plus governing handoff and diff     | `critic-review` or `critic-fix` | `claude-opus-5`, high    | `gpt-5.6-terra`, high     |
| `sentry`       | Sentry       | Reviews a diff for security, authorization, secrets, and PII risks. | `CodeCompleteHandoff` plus diff and relevant architecture | `read-only`                     | `claude-fable-5-1`, high | `gpt-5.6-terra`, high     |
| `publisher`    | Publisher    | Commits, pushes, and opens or updates a PR. Never merges.           | `CodeCompleteHandoff` plus resolved review findings       | `publish-only`                  | `gpt-5.6-terra`, medium  | `claude-sonnet-5`, medium |
| `investigator` | Investigator | Reproduces and diagnoses bugs without landing a fix.                | Bug report, Jira issue, or diagnostic prompt              | `diagnostic`                    | `gpt-5.6-sol`, high      | `claude-fable-5-1`, high  |
| `prosecutor`   | Prosecutor   | Challenges a diagnosis, its evidence, and proposed repair.          | `DiagnosisHandoff` plus available evidence                | `read-only`                     | `claude-opus-5`, high    | `gpt-5.6-terra`, high     |
| `herald`       | Herald       | Reads and classifies GitHub review feedback.                        | Pull request target and review state                      | `read-only`                     | `gpt-5.6-terra`, high    | `claude-sonnet-5`, high   |

## Model routing

1. Evaluate entries in declared order against the selected environment's provider snapshots, and select the first eligible entry. A new entry binds its exact provider instance; legacy driver entries prefer the canonical default instance, then configured order.
2. Require enforceable runtime permissions, an available/enabled/installed provider, an authenticated provider when authentication is reported, and the exact advertised model and supported declared options.
3. Skip observed quota exhaustion with a future reset. Only known account-wide windows count; model-scoped windows do not block unrelated model entries. Missing/no-reset/unsupported telemetry is unknown; retained exhausted observations from a failed probe still apply until their reset.
4. Report each entry with its rejection codes and effective selection when available. Exhaustion fails visibly with per-entry reasons. Each new assignment records the selected entry index; legacy route labels remain on the wire for older clients.

Declared option values must match. Options left unspecified may use provider defaults or an explicit spawn or human-approved Crew choice; the assignment retains the effective selection.

No model spelling is silently rewritten. Persona threads keep their selected provider/model; later provider/model mutations are rejected. Importing a definition does not copy credentials or rewrite account identities for another environment. Legacy definitions and snapshots retain their stored shape; the decoder does not rewrite library files.

## Deliverables

A persona says how to work, not what to produce. The assignment, a brief or a Playbook step, names the deliverable; a file it asks for is written with `j5_write_artifact` and shows up on the Artifacts page like any other requested work. A run owes no file: the server appends no artifact instructions, checks nothing at the end of a run, and sends no reminder. A Crew member's finish notice carries how the run ended and the member's reply.

Tasks that ran before this keep the handoff status they recorded, read-only, on the persona control and chip. Nothing recomputes it.

## Behavioral instructions and runtime permissions

A persona's instructions guide behavior; its one access level controls only the provider sandbox. New definitions and create/edit requests use `access`: `read-only`, `workspace-write`, or `full-access`. No allowed-policy list is written. Legacy definitions remain readable; their default maps to an access level while their allowed list grants no alternative launch mode.

| Access            | Enforcing providers     | Control                                                                                                            |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `read-only`       | Codex, Claude           | Codex read-only sandbox with network disabled; Claude restricted read-only tools with non-interactive permissions. |
| `workspace-write` | Codex                   | Workspace-write sandbox with network disabled and no approval-based escalation.                                    |
| `full-access`     | All supported providers | Ordinary full-access runtime mode with no additional J5 restriction.                                               |

Restricted personas therefore require Codex, or Claude for read-only. Other model entries are marked in the editor and skipped at launch. Provider instruction-delivery support is a separate requirement. J5 adds no policy rules to persona instructions, only the note that platform tools remain available under every sandbox. Behavioral limits such as no commit, no push, targeted edits, or no merge belong in the visible instructions.

`full-access` is the absence of a J5 restriction, not authorization to push, merge, or write external systems; whatever the persona's instructions forbid stays an instruction. It is also the only policy under which the provider may reach the network, because the other policies disable it where the provider can (Codex). A Crew seat's explicit access choice still overrides it; a persona can delegate a subagent only to a persona whose permissions do not exceed its own. A Peer Agent started with `j5_spawn_agent` is not bounded by the caller's runtime policy, so a read-only persona's containment covers its own session, not the agents it spawns. Because any agent that can spawn (Crew members cannot) can start a persona, a persona that declares Full access can be started that way with no human step whenever the caller's harness does not ask before `j5_spawn_agent`: Claude callers in every mode, and Codex callers running with approvals off (a Full access thread, or any persona's runtime policy, read-only included). An ordinary Codex thread in an interactive mode such as Supervised still gets the harness's approval prompt for `j5_spawn_agent`, and other harnesses keep their own prompting. That is why the library marks Full access personas visibly. Crew seats still need the roster approval.

Routing and launch reject unsupported runtime policies. Resume also rejects unsupported policies on new snapshotted assignments. Historical assignments without snapshots retain the prior conservative read-only fallback where applicable. Ordinary threads without personas keep their existing runtime-mode behavior.

Critic's historical example defaults to `critic-review`; its former `critic-fix` choice does not widen new launches. Legacy diagnostic and publish-only definitions stay invalid until their author chooses one of the three access levels.

## Durable assignment and replay

A launch reads and validates the definition once, resolves the route, and atomically writes a content-addressed definition snapshot before issuing the existing `thread.create` command. The `thread.created` event records id, author version, display name, SHA-256 definition digest, authority selection, and resolved provider/model route. The snapshot stores the full instructions in the environment's `agent-persona-snapshots` directory; shell projections and WebSocket catalog responses carry references rather than copying prompts into every row.

The ordinary command receipt remains the replay boundary. A replay reuses its stored launch result rather than reading changed source. Forks inherit the assignment; provider-native children do not. Direct creation validates the referenced snapshot and route. Runtime instruction composition reads the same immutable snapshot, including after an environment restart. Source edits, removal, or source reconfiguration affect new launches only. Missing or modified snapshots cause an explicit failure, never adoption of a newer definition.

Backups and environment migration must preserve snapshots together with the event database. Projection rebuild preserves the assignment references without reading source folders. Pre-library built-in assignments without a digest remain readable through the version-1 compatibility path. This compatibility path does not accept arbitrary custom definitions.

## Clients and activation

Settings → Agent Setup displays the selected environment's persona library, including empty, error, available, and blocked states. Web and mobile use shared presentation logic; desktop inherits web. Clients neither load server-local files nor resolve models. Local, remote, relay, and tunnel clients use the same authenticated catalog RPC.

Activation continues through the existing orchestrator launch contract. New tasks can select a persona, and Agent Setup edits its ordered model entries. A launched task shows its snapshotted display name and fixed route. Runtime activity for launched provider children stays in upstream's Lineage section and subagent cards, separate from the persona library.

Agents can also launch a persona as a Peer Agent: `j5_spawn_agent` accepts an optional `persona` id and refuses any provider, model, and reasoning pick outside that persona's ordered model entries. When the entry declares a reasoning level, the spawn must match it. Otherwise a model with a reasoning control accepts the explicitly requested level; a model with no reasoning control omits it. The resulting thread carries the same immutable assignment as a composer launch. See [agent tools](../a2a/agent-tools.md).

## Verification and remaining work

Focused verification covers imported ids, malformed and missing sources, duplicates, route eligibility, unsupported policies, snapshot integrity, source edits/removal, launch receipts, compatibility with old assignments, and shared client presentation. Server, contracts, and affected client typechecks accompany the focused tests. Browser and simulator verification require an explicit request.

Follow-up work: in-app git commit/push/pull (status nudges and open-in-editor ship; write operations are deliberately out of scope), skill allowlists, access-level editing (#779), and posture visibility. None is marked complete by this contract. A project's [Models for custom members](../features/crews.md) list is not a persona allowlist: a persona always runs on its own configured route, even on a model that list leaves out.

## History

- 2026-09-08 — revised after Jackson's review of [PR #75](https://github.com/Jacksondr5/j5code/pull/75) and Bryant's approval of folder loading first.
- 2026-09-24 — upstream removed the Agents right panel in the V2 advance (PR #262); handoff status and persona identity for delegated children moved to the chip beside their Lineage rows and subagent cards.
- 2026-09-24 — the J5 document is named "handoff artifact" to distinguish it from upstream's context handoffs.
- 2026-10-03 — a runtime policy means only what the provider's sandbox enforces (Jackson, [#439](https://github.com/Jacksondr5/j5code/issues/439)).

- 2026-11-03 — ordered model editing, per-entry eligibility and quota-aware new launches ([#778](https://github.com/Jacksondr5/j5code/issues/778)).
