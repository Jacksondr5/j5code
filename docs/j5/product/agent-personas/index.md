---
title: "Agent persona definition contract"
kind: spec
status: 1
---

# Agent persona definition contract

Revised 2026-09-08 following [Jacksondr5's PR #75 review](https://github.com/Jacksondr5/j5code/pull/75) and Bryant's approval of folder loading first. A **persona** is the current implementation of a user-authored [Role](../features/roles.md), not a second product concept. The eleven definitions below are starter examples, not a closed platform registry or a prescribed workflow.

## Delivery boundary

PR #75 defines the contract. Runtime delivery belongs to the dependent PRs; neither this document nor the backlog claims that the stack is merged or that every planned Role capability is complete.

This revision delivers folder discovery, definition validation, configurable definitions and instructions, environment-specific routing, immutable launch snapshots, and Settings folder/single-agent import across web, desktop, and mobile. Existing orchestrators remain responsible for activation. Instruction editing, direct human selection in the new-task composer, Role-library git controls, skill allowlists, posture controls, and drift indicators are follow-up work. The Roles feature document retains that long-term direction and labels these delivery limits explicitly.

Crew composition, Playbook steps, workflow gates, and lifecycle automation remain separate features. A persona file describes the agent; the per-task brief still supplies the work.

## User-authored library

- Settings → Agents offers **Create agent**, which authors a personal agent (name, stable ID, description, markdown instructions, runtime policy, primary and fallback models) and stores it as an imported definition of the selected environment; the server supplies the remaining contract fields. It also offers one **Import** menu with **Agent file** (one YAML definition) and **Folder** (all YAML definitions, including subfolders). The selected files are copied into the selected environment, so the same flow works remotely. Up to 50 files of 64 KiB each are validated as one atomic batch.
- Imported agents can be edited in Settings: name, description, instructions, runtime policy, and primary/fallback models with reasoning settings. Any listed agent, including bundled examples and removed sources, can be duplicated into a personal agent or exported as YAML. Changes apply only to the imported copy and future launches, preserve enabled state, and reject stale concurrent edits.
- Imported agents have an environment-local **On/Off** setting. New imports start enabled; disabling prevents new launches and keeps the entry visible. Replacement imports preserve the setting; removing an import clears it. Running tasks retain their snapshots.
- UI imports show a confirmation for existing IDs: each conflicting agent has a replacement toggle. Cancel imports nothing; Import selected imports new agents and overwrites only the selected existing definitions, including local edits, while preserving enabled state and saved tasks. Toggled-off agents are skipped throughout the import. New or changed conflicts require fresh confirmation. Duplicate IDs within a selection fail the batch. The trash action removes the imported copy and excludes any underlying source definition, without altering running tasks. Removed source and bundled definitions stay listed as **Removed** with a **Restore** action, so removal from Settings is reversible without any file. Source edits require reimporting unless the server reads that folder directly through configuration.
- A library combines imported copies with optional source folders on the selected environment's filesystem. Definitions are plain YAML files with markdown instruction content, editable and shareable through ordinary editors and git. Git is optional. Loading never clones, pulls, pushes, or executes a file.
- For directly configured source folders, each immediate `.yaml` or `.yml` file holds one definition. JSON files are ignored there and rejected on import. Nested directories and other file types are ignored. Configuration selects folders explicitly; order is preserved and filenames are sorted. Duplicate ids fail the library read rather than silently choosing a winner.
- The default library folder is `personas` below the environment's state directory. If that folder and explicit configuration are absent, the application offers the bundled examples. An existing empty folder or explicit empty folder list yields no source definitions; imports remain available. Explicit configuration replaces the examples; it never implicitly merges or overrides them.
- `<stateDir>/agent-personas.json` accepts `{ "folders": ["personas", "/absolute/team-library"] }`. Relative paths resolve from that environment's state directory. Configuration and source files are re-read at catalog requests and new activations; no restart or continuous watcher is required. Reopening Settings reads the library again. Settings → Agents → **Library sources** lists and edits this file through J5 RPCs, shows each folder's existence and definition count, and, for folders inside a git checkout, the two permitted nudges (uncommitted changes, remote ahead) plus an open-in-editor action on web/desktop. The server only reads `git status`; it never fetches, pulls, or commits.
- Every catalog entry carries an `origin` (`bundled`, `imported`, or `folder` with the source file path), shown as a badge. A per-agent usage line (tasks, runs, completed/failed, mean completed-run duration, provider-reported tokens, last launch, resolved routes) is aggregated from existing thread, run, and provider-turn projections on request through `getAgentPersonaUsage`; nothing new is persisted.
- **Copy to environment** in a row's more menu reads the agent's YAML from the selected environment and imports it into another connected environment with the ordinary conflict confirmation; personal agents therefore stay environment-local by default and travel only on request.
- Missing configured folders, malformed configuration or definitions, undefined structured artifacts, and duplicate ids produce an actionable library error. A launch fails before thread creation. No invalid source silently falls back to the examples.
- The same validation applies to bundled and imported definitions. The bundled examples are compiled into the server; to make an editable copy, write the same fields as a YAML file in a source folder or import it.

## Definition format

Each definition has:

| Field                                                  | Meaning                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                                   | Stable lowercase slug, such as `team-researcher`. Custom ids require no code changes.                                                                                    |
| `version`                                              | Positive integer chosen by the author. Changing it communicates a revision; content is also fingerprinted, so same-version edits are detected at launch.                 |
| `displayName`, `description`                           | Human-facing identity and a concise purpose.                                                                                                                             |
| `instructions`                                         | Nonempty markdown identity and operating principles, at most 32,768 characters. The spawner supplies the task brief separately.                                          |
| `acceptedInput`                                        | Optional human-readable input summary; ordinary prompts and supporting evidence are allowed.                                                                             |
| `inputArtifacts`, `outputArtifact`                     | Optional structured handoff names for pipeline roles. Every reference must name a standard artifact below or one declared by this definition. Personal agents omit them. |
| `artifacts`                                            | Optional names for user-defined artifacts. These declare references, not executable validators.                                                                          |
| `authority.defaultPolicy`, `authority.allowedPolicies` | A default and allowed selection from the runtime-policy vocabulary below. The default must be allowed.                                                                   |
| `modelRoute`                                           | Ordered primary and fallback targets. Each names `driver`, exact `model`, and `reasoningEffort`.                                                                         |

Files are limited to 64 KiB. This slice retains exactly two route targets and supports routing to Codex and Claude. Other providers are unavailable for persona activation until their adapter policies are supported. Broader ordered model allowlists belong to a later Role-library revision; none of these limits fixes the persona's name or model choices to the starter examples.

## Starter examples

These examples are user-editable content. Their operating instructions describe intended behavior, including no-commit or no-merge expectations; those words do not themselves enforce permissions.

| ID             | Display name | Description                                                         | Accepted input                                            | Required output       | Authority                       | Primary route            | Secondary route           |
| -------------- | ------------ | ------------------------------------------------------------------- | --------------------------------------------------------- | --------------------- | ------------------------------- | ------------------------ | ------------------------- |
| `scout`        | Scout        | Collects cited evidence into a Context Brief. Read-only.            | Evidence request or prompt                                | `ContextBrief`        | `read-only`                     | `gpt-5.6-terra`, high    | `claude-opus-5`, high     |
| `navigator`    | Navigator    | Turns a Context Brief into an implementation plan. Read-only.       | `ContextBrief`                                            | `PlanHandoff`         | `read-only`                     | `gpt-5.6-sol`, high      | `claude-fable-5-1`, high  |
| `advocate`     | Advocate     | Checks a plan against product and design requirements.              | `PlanHandoff` plus Jira, Confluence, or Figma evidence    | `PlanCritique`        | `read-only`                     | `claude-sonnet-5`, high  | `gpt-5.6-terra`, high     |
| `skeptic`      | Skeptic      | Stress-tests a plan for feasibility, risk, and hidden scope.        | `PlanHandoff` plus repository evidence                    | `PlanCritique`        | `read-only`                     | `claude-opus-5`, high    | `gpt-5.6-terra`, high     |
| `builder`      | Builder      | Implements an approved handoff. Never commits or pushes.            | `PlanHandoff`, `DiagnosisHandoff`, or `ReviewInbox`       | `CodeCompleteHandoff` | `workspace-write`               | `gpt-5.6-sol`, high      | `claude-opus-5`, high     |
| `critic`       | Critic       | Reviews implementation; Fix Mode may apply targeted fixes.          | `CodeCompleteHandoff` plus governing handoff and diff     | `ReviewHandoff`       | `critic-review` or `critic-fix` | `claude-opus-5`, high    | `gpt-5.6-terra`, high     |
| `sentry`       | Sentry       | Reviews a diff for security, authorization, secrets, and PII risks. | `CodeCompleteHandoff` plus diff and relevant architecture | `ReviewHandoff`       | `read-only`                     | `claude-fable-5-1`, high | `gpt-5.6-terra`, high     |
| `publisher`    | Publisher    | Commits, pushes, and opens or updates a PR. Never merges.           | `CodeCompleteHandoff` plus resolved review findings       | `PublicationReceipt`  | `publish-only`                  | `gpt-5.6-terra`, medium  | `claude-sonnet-5`, medium |
| `investigator` | Investigator | Reproduces and diagnoses bugs without landing a fix.                | Bug report, Jira issue, or diagnostic prompt              | `DiagnosisHandoff`    | `diagnostic`                    | `gpt-5.6-sol`, high      | `claude-fable-5-1`, high  |
| `prosecutor`   | Prosecutor   | Challenges a diagnosis, its evidence, and proposed repair.          | `DiagnosisHandoff` plus available evidence                | `DiagnosisCritique`   | `read-only`                     | `claude-opus-5`, high    | `gpt-5.6-terra`, high     |
| `herald`       | Herald       | Reads and classifies GitHub review feedback.                        | Pull request target and review state                      | `ReviewInbox`         | `read-only`                     | `gpt-5.6-terra`, high    | `claude-sonnet-5`, high   |

## Model routing

1. Evaluate primary, then fallback, against the selected environment's current provider snapshots. No project-default or third route is inferred.
2. Require supported runtime permissions before selecting a target. For matching instances, prefer the canonical default instance, then configured order.
3. Require an available driver, enabled and installed instance, no error/disabled state, no unauthenticated state, and the exact advertised model and reasoning option.
4. Return a canonical environment-local `ModelSelection`, with the provider-specific reasoning option, or typed rejection reasons.

No model spelling is silently rewritten. Persona threads keep their selected provider/model; later provider/model mutations are rejected. Importing a definition does not copy credentials or environment-local provider ids.

## Artifact contracts

The following names describe minimum handoff contents. They are not workflow engines or evidence that runtime output validation exists. Only `inputArtifacts` and `outputArtifact` are structured references; `acceptedInput`, ordinary prompts, evidence, and prose counterpart references are not parsed as artifacts.

### `ContextBrief`

- Request and bounded scope.
- Sources consulted, with stable citations or paths.
- Relevant facts separated from inference.
- Conflicts, missing evidence, and access limitations.
- Concise findings suitable for planning.

### `PlanHandoff`

- Objective, scope, and explicit non-goals.
- Product-sliced delivery tracks.
- Dependencies and sequencing constraints.
- Expected files or architectural boundaries.
- Validation strategy, risks, and unresolved decisions.

### `PlanCritique`

- Reviewer lens: `advocate` or `skeptic`.
- Finding list with evidence and severity.
- Covered, partial, missing, or contested items where applicable.
- Required revisions and non-blocking observations.
- Verdict: `accept`, `revise`, or `blocked`.

### `CodeCompleteHandoff`

- Governing handoff and implemented scope.
- Changed paths and behavior summary.
- Tests and checks run with results.
- Known limitations, residual risks, and unverified areas.
- Review-ready diff identity when available.
- Explicit statement that no commit or push was performed.

### `ReviewHandoff`

- Review lens: functional or security.
- Findings with severity, evidence, and affected paths.
- Validation performed.
- Fixes applied, only when the activation authorized them.
- Remaining findings and verdict.
- Explicit statement that no commit was performed.

### `PublicationReceipt`

`PublicationReceipt` is the canonical name for Publisher's output.

- Branch and commit SHA or ordered commit SHAs.
- Conventional commit subjects.
- Push target and result.
- Pull request number and URL.
- Whether the pull request was opened or updated.
- Checks or publication failures observed before handoff.
- Explicit `merged: false` assertion.

### `DiagnosisHandoff`

- Expected and observed behavior.
- Deterministic reproduction or the strongest bounded attempt.
- Failing boundary and causal mechanism supported by evidence.
- Alternatives considered and ruled out.
- Minimal fix sketch, without landing the fix.
- Confidence, limitations, and recommended validation.

### `DiagnosisCritique`

- Reproduction gaps or contradictions.
- Root-cause challenges and viable alternatives.
- Evidence quality and missing proof.
- Over-broad or unsafe repair concerns.
- Verdict: `accept`, `revise`, or `blocked`.

### `ReviewInbox`

- Review source and stable comment or thread identity.
- Blocking request, actionable non-blocker, or nit classification.
- Requested change mapped to relevant paths or lines when known.
- Duplicate, superseded, resolved, or still-open state.
- Ambiguities requiring human clarification.

## Behavioral instructions and runtime permissions

A Role guides behavior. Its text does not grant permissions or guarantee compliance. The following matrix records the intended behavior of the supplied policy vocabulary; action restrictions such as no commit, no push, targeted edits only, or no merge are operating instructions unless a concrete runtime control is identified below.

| Policy            | Workspace                                              | Commands and tests                                                            | Git                             | Pull requests                     | External systems                       |
| ----------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------- | --------------------------------- | -------------------------------------- |
| `read-only`       | Read only                                              | Inspection and read-only retrieval only                                       | Inspect only                    | Read only                         | Read only                              |
| `workspace-write` | May edit product and test files                        | May build, test, lint, and inspect                                            | Inspect only; no commit or push | Read only                         | Read only unless separately authorized |
| `critic-review`   | Read only                                              | Inspection and focused validation                                             | Inspect only                    | Read only                         | Read only                              |
| `critic-fix`      | May edit only to address requested review findings     | May run focused validation                                                    | Inspect only; no commit or push | Read only                         | Read only                              |
| `diagnostic`      | Product source must be unchanged at handoff            | May reproduce, build, test, debug, and create disposable diagnostic artifacts | Inspect only; no commit or push | Read only                         | Read only                              |
| `publish-only`    | May read completed work; may not implement or refactor | Publication checks only                                                       | May commit and push             | May open or update; may not merge | Writes limited to publication actions  |

No supplied persona is instructed to merge a pull request. The application appends the selected policy's behavioral instructions to the snapshotted definition when composing new persona sessions. This does not create an action-level enforcement guarantee.

| Runtime policy                  | Supported provider | Enforced control / activation status                                                                                              |
| ------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `read-only`, `critic-review`    | Codex              | Non-interactive read-only sandbox; network disabled.                                                                              |
| `read-only`, `critic-review`    | Claude             | Restricted read-only tool list with non-interactive permissions.                                                                  |
| `workspace-write`, `critic-fix` | Codex              | Workspace-write sandbox, network disabled, no approval-based escalation. No-commit and targeted-fix behavior remain instructions. |
| `workspace-write`, `critic-fix` | Others             | Activation unavailable.                                                                                                           |
| `diagnostic`                    | None yet           | Unavailable pending a completion mechanism for the clean-product-source requirement.                                              |
| `publish-only`                  | None yet           | Unavailable pending restricted publication operations. Never translated into unrestricted access.                                 |

Routing and launch reject unsupported runtime policies. Resume also rejects unsupported policies on new snapshotted assignments. Historical assignments without snapshots retain the prior conservative read-only fallback where applicable. Ordinary threads without personas keep their existing runtime-mode behavior.

Critic's example defaults to `critic-review`; `critic-fix` must be explicitly requested and allowed by the definition. Investigator's clean-source handoff and Publisher's publication-only scope are retained requirements for their eventual supported operations, not claims that a generic shell enforces them.

## Durable assignment and replay

A launch reads and validates the definition once, resolves the route, and atomically writes a content-addressed definition snapshot before issuing the existing `thread.create` command. The `thread.created` event records id, author version, display name, SHA-256 definition digest, authority selection, and resolved provider/model route. The snapshot stores the full instructions in the environment's `agent-persona-snapshots` directory; shell projections and WebSocket catalog responses carry references rather than copying prompts into every row.

The ordinary command receipt remains the replay boundary. A replay reuses its stored launch result rather than reading changed source. Forks inherit the assignment; provider-native children do not. Direct creation validates the referenced snapshot and route. Runtime instruction composition reads the same immutable snapshot, including after an environment restart. Source edits, removal, or source reconfiguration affect new launches only. Missing or modified snapshots cause an explicit failure, never adoption of a newer definition.

Backups and environment migration must preserve snapshots together with the event database. Projection rebuild preserves the assignment references without reading source folders. Pre-library built-in assignments without a digest remain readable through the version-1 compatibility path. This compatibility path does not accept arbitrary custom definitions.

## Clients and activation

Settings → Agents displays the selected environment's persona library, including empty, error, available, and blocked states. Web and mobile use shared presentation logic; desktop inherits web. Clients neither load server-local files nor resolve models. Local, remote, relay, and tunnel clients use the same authenticated catalog RPC.

Activation continues through the existing orchestrator launch contract. No direct persona picker or editor is added in this slice. A launched task shows its snapshotted display name and fixed route. The Agents right panel remains the separate runtime-activity view for launched provider children and workflows.

## Verification and remaining work

Focused verification covers imported ids and custom artifacts, malformed and missing sources, duplicates, route eligibility, unsupported policies, snapshot integrity, source edits/removal, launch receipts, compatibility with old assignments, and shared client presentation. Server, contracts, and affected client typechecks accompany the focused tests. Browser and simulator verification require an explicit request.

Follow-up work: in-app git commit/push/pull (status nudges and open-in-editor ship; write operations are deliberately out of scope), skill and model allowlists beyond this slice, posture visibility, richer artifact schemas and output validation, and supported diagnostic/publication operations. None is marked complete by this contract.
