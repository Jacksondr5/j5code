---
title: "Agent persona definition contract"
kind: spec
status: 1
---

# Agent persona definition contract

Phase 1 contract settled 2026-09-02 from the FH Code agent-persona chart. This document defines the individual application-level agents only. Orchestrator flows, loops, gates, team composition, and lifecycle automation are explicitly out of scope.

## Contract boundary

An agent persona is a reusable application definition with five independent concerns:

1. **Identity** — stable id, display name, and description.
2. **Artifact contract** — accepted inputs and required output.
3. **Model route** — an ordered primary and secondary model selection.
4. **Authority policy** — what the agent may read, change, publish, or merge.
5. **Activation mode** — an explicit mode when one persona supports materially different authority, as Critic does.

The definition is not a running agent, provider session, thread, or orchestrator. Later delivery phases resolve a definition against one environment and snapshot the result onto a launched thread.

## Stable persona registry

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

Persona ids are lowercase and immutable after release. Display names and descriptions may evolve under a new definition version, but an existing thread keeps the version it launched with.

## Model-route contract

Each model route is an ordered pair:

1. Use the primary only when a matching provider instance is enabled, available, exposes the named model and reasoning level, and can enforce the persona authority.
2. Otherwise evaluate the secondary by the same rules.
3. If neither route is eligible, the persona is unavailable.

There is no implicit project-default or application-default third fallback. This preserves the chart's deliberate separation between authoring and reviewing model families. Once a thread starts, its resolved route is sticky; a later failover must be explicit rather than silently changing the active model.

Provider instance ids remain environment-local. These definitions name logical model targets; a later phase binds each target to a configured instance in the selected environment.

### Skeptic model-name resolution

The chart's `gpt-5-6-terra` spelling is normalized to the canonical `gpt-5.6-terra`, matching every other Terra route. The hyphenated spelling is not an accepted alias and should fail definition validation if it reappears.

## Artifact contracts

Artifacts are structured handoffs, not implementation storage or workflow engines. Phase 1 fixes their names and minimum contents; later phases may choose the wire representation.

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

## Authority policies

Prompt wording is not authorization. A later runtime phase must compile these policies into the strongest controls each provider supports and fail closed when a required boundary cannot be enforced.

| Policy            | Workspace                                              | Commands and tests                                                            | Git                             | Pull requests                     | External systems                       |
| ----------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------- | --------------------------------- | -------------------------------------- |
| `read-only`       | Read only                                              | Inspection and read-only retrieval only                                       | Inspect only                    | Read only                         | Read only                              |
| `workspace-write` | May edit product and test files                        | May build, test, lint, and inspect                                            | Inspect only; no commit or push | Read only                         | Read only unless separately authorized |
| `critic-review`   | Read only                                              | Inspection and focused validation                                             | Inspect only                    | Read only                         | Read only                              |
| `critic-fix`      | May edit only to address requested review findings     | May run focused validation                                                    | Inspect only; no commit or push | Read only                         | Read only                              |
| `diagnostic`      | Product source must be unchanged at handoff            | May reproduce, build, test, debug, and create disposable diagnostic artifacts | Inspect only; no commit or push | Read only                         | Read only                              |
| `publish-only`    | May read completed work; may not implement or refactor | Publication checks only                                                       | May commit and push             | May open or update; may not merge | Writes limited to publication actions  |

No persona defined here may merge a pull request.

## Investigator diagnostic-write boundary

Investigator receives the `diagnostic` policy:

- It may execute builds, tests, debuggers, local services, and reproduction commands.
- It may create temporary or ignored diagnostic artifacts.
- If temporary instrumentation in tracked product source is unavoidable, it must be isolated and fully reverted before the handoff.
- It may not leave tracked product-source changes, implement the proposed fix, commit, push, or mutate a pull request.
- Its handoff must distinguish observed evidence from the minimal fix sketch.

The acceptance condition is a clean product-source diff attributable to Investigator when it finishes. Diagnostic logs or intentionally retained fixtures require explicit authorization outside this persona contract.

## Critic activation modes

Critic has two explicit modes because applying fixes materially changes its authority.

### Review Mode

- Canonical mode id: `critic-review`.
- Default for every Critic activation.
- Read-only review and focused validation.
- Produces a `ReviewHandoff` without changing product source.

### Fix Mode

- Canonical mode id: `critic-fix`.
- Must be selected explicitly by the user or supplied in an authorized activation request.
- May change only the files needed to resolve identified review findings.
- Must report each applied fix and its validation in `ReviewHandoff`.
- Still may not commit, push, open or update a pull request, or merge.

Fix Mode is not inferred from phrases such as "review and fix anything you find" unless the application records the activation as `critic-fix`.

## Definition validation

A persona catalog is valid only when:

- Every id is unique and uses the stable id above.
- Every input and output references a defined artifact name.
- Every model route has exactly one primary and one secondary target.
- Model ids and reasoning values match their canonical spellings.
- Every persona references a defined authority policy.
- Critic has exactly the two modes defined above and defaults to Review Mode.
- Publisher outputs `PublicationReceipt` and carries no merge authority.
- Investigator uses `diagnostic` and cannot finish with product-source changes.
- No implicit fallback target is introduced.

## Phase 1 completion boundary

Phase 1 ends with this definition contract. It does not add contracts to `packages/contracts`, runtime services, provider resolution, persistence, UI, launch behavior, provider adapters, or enforcement code. Those are separate delivery phases governed by this document.

## Phase 2: application catalog

Phase 2 materializes this contract as the built-in application catalog at `apps/server/src/j5/agents/agentPersonas.ts`.

- The catalog is server-owned and has no persistence or environment-specific state.
- Each definition has a stable id, version, description, accepted-input summary, typed input and output artifacts, authority choices, and an ordered two-target model route.
- A model target identifies the provider driver, exact model, and reasoning effort. Provider-instance binding remains environment-local and is deferred.
- Critic exposes `critic-review` as its default and permits only the explicit `critic-fix` alternative.
- The catalog exposes deterministic list and lookup operations for later application services.

Phase 2 does not add provider-instance resolution, fallback execution, prompt composition, thread snapshots, persistence, wire contracts, UI, or authority enforcement. No client can select or launch these personas yet.

## Phase 3: routing and availability

Phase 3 resolves a built-in persona route against one environment's ordered live provider snapshots.

1. Evaluate the primary target, then the fallback target. There is no third or project-default route.
2. For each target, prefer the driver's canonical default instance, then preserve configured snapshot order for custom instances.
3. An instance is eligible only when its driver is available, it is enabled and installed, it is not in an error or disabled state, it is not unauthenticated, and it advertises the exact model and reasoning effort.
4. Return the first eligible environment-local instance as a canonical `ModelSelection` with the provider-specific reasoning option.
5. If a target is ineligible, retain typed failure reasons. If both targets fail, report the persona as unavailable.

Resolution happens before launch. The selected route is intended to be snapshotted onto the new thread; Phase 3 does not silently switch providers or models during an active thread or turn.

Phase 3 adds no implicit aliases. In particular, an unavailable model spelling remains unavailable rather than being rewritten to a nearby model. Provider refresh, launch integration, authority compilation, persistence, wire contracts, and UI remain deferred.

## Phase 4: durable agent assignment

Phase 4 makes a resolved persona assignment durable at thread creation.

- A launch request names the built-in persona and may explicitly request one of that persona's allowed authority policies.
- The server resolves Phase 3 routing from current environment provider snapshots. The resolved model selection replaces any generic launch default.
- The `thread.created` event atomically snapshots persona id, definition version, authority policy, primary-or-fallback route, provider driver, and resolved model selection.
- Thread detail and shell projections retain the assignment, and projection rebuild reproduces it from the event store.
- The assignment field is optional so existing events, projections, and ordinary threads remain compatible.
- Forks inherit the source thread's assignment. Provider-created subagent threads do not inherit it because they are not activations of the application persona.

The assignment and resolved model route are immutable for the lifetime of the thread. Model-selection and provider-switch commands are rejected for persona threads so the displayed route and effective runtime cannot drift apart.

Phase 4 assigns only newly created threads; attaching or replacing a persona on an existing thread is not supported. Prompt composition, authority enforcement, UI selection, artifact validation, and orchestrator behavior remain deferred.

## Phase 5: provider policy translation

Phase 5 translates the durable application authority policy into the canonical runtime policy already consumed by provider adapters. Translation occurs whenever the application resolves runtime policy for session open, resume, fork, or turn start, so the durable persona policy takes precedence over the thread's generic runtime-mode setting.

| Application authority        | Eligible providers | Effective policy                                                                  |
| ---------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `read-only`, `critic-review` | Codex and Claude   | Non-interactive read-only access; Claude receives only its read-only tool list    |
| `workspace-write`            | Codex              | `never` approvals with a network-disabled `workspaceWrite` sandbox                |
| `critic-fix`                 | Codex              | Same workspace sandbox, only after Fix Mode is explicitly requested               |
| `diagnostic`                 | None yet           | Blocked until a clean-product-source completion guard enforces the write boundary |
| `publish-only`               | None yet           | Blocked until publication is exposed through restricted non-merge operations      |

Ordinary threads without an agent assignment continue to use their selected runtime mode. Persona threads retain their server-resolved provider and model for their lifetime.

Routing now includes authority enforceability. Claude write modes are not treated as workspace/git sandboxes, and any unsafe historical assignment degrades to read-only at runtime. Investigator and Publisher remain visible but blocked until their completion and action-level guards exist; no persona receives unrestricted provider access.

## Phase 6: top-level UX

Phase 6 makes built-in personas discoverable across web, desktop, and mobile without making them directly selectable by users.

- Settings includes an **Agents** destination that explains every built-in persona's purpose, accepted input, output artifact, default authority, and environment-resolved provider/model route.
- A server read endpoint projects this presentation-safe catalog together with availability resolved from the selected environment's live provider snapshots. Clients do not duplicate persona definitions or routing rules.
- Agent activation remains an application/orchestrator operation. New-task composers retain their existing model, reasoning, runtime, and interaction controls and do not offer a persona selector.
- Critic Review versus Fix remains an explicit activation-policy choice for an orchestrator, not an end-user composer control.
- After an orchestrator launches a persona, the durable assignment and its exact provider/model route are shown as fixed labels on the thread. They cannot be attached, removed, replaced, or switched from the client.

Desktop inherits the web settings surface. Prompt composition, skill-orchestrator invocation, artifact validation, and action-level authority guards remain deferred.

## Phase 7: verification

Phase 7 verifies the Phase 1–6 contract at the server, shared-client, persistence, and provider-policy boundaries. It reflects the Phase 6 decision that personas are informational in Settings and activated by skill orchestrators rather than selected in a new-task composer.

Acceptance requires:

- The server catalog contains exactly the eleven stable persona ids. Web and mobile both render the complete server response through the same one-to-one presentation helper; desktop inherits web.
- Every persona resolves to its declared primary model only when both the route and authority are enforceable.
- Every persona resolves only to its declared secondary model after the primary is rejected. No third fallback is accepted.
- If both declared routes fail, Settings displays **Blocked** with either “Primary and fallback models unavailable” or “Required authority is not yet enforceable,” and a launch attempt fails before thread creation at the same clear boundary.
- Builder's application authority allows workspace edits but denies commit, push, pull-request mutation, and merge.
- Publisher remains blocked until commit, push, and pull-request publication can be brokered without exposing merge authority.
- Read-only personas and Critic Review Mode compile to non-interactive read-only provider policies.
- Critic defaults to Review Mode; workspace editing is available only when an activation request explicitly carries `critic-fix`.
- The complete resolved assignment remains in the `thread.created` event and survives projection rebuilds without consulting the current definition. Definition changes therefore do not rewrite running or historical assignments, and later provider/model mutations are rejected.
- Environment availability and the resolved provider, model, and primary-or-fallback result are calculated by the server. Web and mobile present those values without client-side route resolution, including for remote environments.
- A skill orchestrator can request one persona through the ordinary new-thread launch contract without constructing a workflow graph or sequence. There is no direct persona selector in client composers.

The focused acceptance suite covers the catalog, all-persona route matrix, authority-aware blocked states, provider translation, Critic mode selection, server-owned assignment validation, direct launch, and durable projection rebuild. Narrower Investigator and Publisher operations remain later work and fail closed until implemented.

## Phase 8: Builder prompt

Phase 8 begins persona prompt composition with Builder definition version 1.

- The server resolves Builder's versioned instructions from its durable persona assignment and sends them through the provider's native developer or system instruction channel. The governing handoff remains the user message.
- Builder accepts a `PlanHandoff`, `DiagnosisHandoff`, or `ReviewInbox`; a review inbox directs it to apply and disposition Critic and Sentry findings.
- Builder returns the defined `CodeCompleteHandoff`, including changed behavior, validation, residual risk, review-ready diff identity, and an explicit no-commit/no-push statement.
- The prompt reinforces but does not replace the `workspace-write` runtime authority policy. Builder must never commit, push, mutate a pull request, or merge.
- Other persona prompts and artifact wire validation remain later work.

## Agents right-panel boundary

The web and desktop Agents right panel remains a runtime activity surface for provider-native child agents and workflows. It does not present durable persona assignments or the built-in persona catalog.

Built-in agent discovery remains under Settings, and skill orchestrators continue to own persona activation. This keeps reusable application definitions separate from agents that have actually been launched for a task.
