---
title: "T3 Code — multi-agent & providers deep dive"
kind: spec
---

# Multi-agent & providers

<user_quoted_section>This is the most directly relevant artifact for our project. The March report said T3 had no multi-agent capabilities. That is wrong on current main.</user_quoted_section>

## The shape of T3's multi-agent story

**T3 observes fleets; it does not orchestrate them.**

The provider spawns the fleet — Claude Code's Task/subagent tooling, Codex's child agents, workflow runs with phases. T3's server ingests those lifecycle events, persists them as thread activities, and every client folds them into a source-neutral roster rendered in the **Agents panel**.

This is a genuinely useful division for us:

| Concern                      | Who owns it in T3                 | Who'd own it for us         |
| ---------------------------- | --------------------------------- | --------------------------- |
| Deciding to spawn N agents   | The provider / the prompt         | Traycer-style orchestration |
| Spawning + running them      | The provider CLI                  | The provider CLI            |
| Lifecycle events on the wire | T3 contracts (`TaskAgentLinkage`) | Steal wholesale             |
| Fold into a roster           | `subagentRuntime.ts`              | Steal the invariants        |
| Rendering the fleet          | `AgentsPanel.tsx`                 | Steal the visual rules      |

T3 solves the observability half well enough that we should treat it as a reference implementation and put our differentiation in the orchestration half.

## The data model

`packages/contracts/src/providerRuntime.ts` defines **`TaskAgentLinkage`** — optional identity fields carried on _every_ task lifecycle payload:

```
taskType, agentKind, agentId, title, role, model, effort, toolUseId,
parentAgentId, workflowName, agentIndex, phaseIndex, phaseTitle, phases[],
attempt, runHandles{runId, scriptPath, transcriptDir, sessionUrl},
outputFile, agentPath, timelineBypass
```

Two design decisions here are worth copying verbatim:

**1. Linkage repeats on every row, not just on start.**

<user_quoted_section>"Repeated on progress and terminal rows (not just start) so client folds can reconstruct an agent even when its start row aged out of activity retention. All fields optional: old emitters and old rows decode unchanged."</user_quoted_section>

Activity retention will evict old rows. If identity only lives on the start event, long-running agents lose their identity. This is a bug we would otherwise ship.

**2. Classification is a denylist, and the comment says why.**

```ts
MONITOR_TASK_TYPES = { monitor, monitor_mcp, local_bash, shell }
INERT_TASK_TYPES   = { plan, dream }
classifyTaskAgentKind({taskType, agentId}) -> "agent" | "background"
```

<user_quoted_section>"A deliberate denylist: the SDK's agent-flavored type names drift (subagent, local_agent, local_workflow, …) and an allowlist silently dropped real subagents when 'local_agent' appeared."</user_quoted_section>

An allowlist fails **closed and silently** against a vocabulary you don't control. When your upstream is a third-party SDK whose type names drift, denylist. Also note the nesting rule: a task launched from inside a subagent (`agentId` set) is agent-internal background work _unless it is itself agent-flavored_ — a nested agent can outlive its parent and stays in the roster.

Classification is **stamped server-side at ingestion** (`agentKind`) so persisted rows are self-describing; clients trust the stamp outright and only fall back to heuristics for legacy pre-stamp rows.

Codex additionally gets `agentPath` (a hierarchy path like `"/root/marlow"`) and `timelineBypass` — a flag on provider-synthesized child-agent events saying "this belongs in the Agents surface, never the parent timeline." Without that flag a fan-out floods the main chat.

## The fold

`packages/client-runtime/src/state/subagentRuntime.ts` — 940 lines, plus a test file.

`RuntimeSubagent` carries: `id`, `kind` (`"subagent" | "workflow" | "workflow_agent"`), `title`, `role`, `model`, `effort`, `status`, `activationCount`, `usage`, `progress`, `lastToolName`, `result`, `error`, `outputFile`, `parentAgentId`, `agentIndex`, `phaseIndex`, `phaseTitle`, `attempt`, `workflowName`, `phases[]`, `runHandles`, `recentActivity[]`, `firstSeenAt`, `startedAt`, `completedAt`, `updatedAt`.

Eight statuses: `pending`, `running`, `waiting`, `idle`, `completed`, `failed`, `cancelled`, `interrupted`.

`SubagentUsage` rolls up `totalTokens`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`, `toolUses`, `durationMs`.

### The invariants — each traced to a shipped bug

The file's header comment lists them with PR numbers (#4220, #3650, #4662):

| Invariant                                     | Why                                                                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reusable identity vs one-shot activations** | An agent id can be resumed; `activationCount` distinguishes "same agent again" from "new agent".                                               |
| **`idle` is a real nonterminal state**        | A resting agent is resumable, not done. The panel renders it muted — live testing showed a "sky" (in-progress blue) idle dot reads as _stuck_. |
| **Provider-specific usage merges**            | Each provider reports token usage differently; merging is per-provider (`packages/shared/src/usageMerge.ts`).                                  |
| **First-write terminal timestamps**           | `completedAt` is written once; a duplicate terminal event must not move it.                                                                    |
| **Reactivation clears terminal detail**       | Resuming a completed agent must clear its old result/error.                                                                                    |
| **Order-robust folding**                      | _"Completion can create an agent; a late start only fills metadata."_ Events arrive out of order. Do not assume a start precedes a finish.     |

That last one is the single most valuable line in the file for us.

### Migration warning

The header is explicit:

<user_quoted_section>"This module is deliberately legacy-bridge code. When orchestration-v2's subagent projection is available for a thread, deriveAgentPanelModel prefers it (see the v2Projection parameter) and the fold is skipped; when the v1 orchestrator is retired this file is deleted. Field names and transition semantics copy the v2 stack (#4779) exactly so that swap is mechanical."</user_quoted_section>

So: **copy the shape and the invariants, don't copy the architecture.** The direction of travel is a _server-side_ subagent projection, with the client fold as a compatibility shim. If we build fresh, build the server projection — that's where T3 is going.

## The Agents panel — visual rules

`apps/web/src/components/AgentsPanel.tsx` (581 lines). Its header comment is a design spec derived from live testing, and every rule is a performance or legibility decision:

- **"Spawn order is stable. Activity and completion update rows in place."** No reordering as agents finish — you can watch a specific agent.
- **"Agent rows reserve three fixed lines for identity, activity, and metrics; changing data must never change their height."** Fixed-height rows mean no layout thrash and no scroll jump during a 20-agent fan-out. This is the same discipline as the chat list's virtualization stability.
- **"Workflow expansion is presentation state. A live run stays expanded when it settles."** State changes must not collapse what you're watching.
- **"Static status dots, DOM-write elapsed timers, plain token counters."** Elapsed timers write directly to the DOM instead of re-rendering React every second; dots don't animate. This is AGENTS.md's "no continuously repainting animations; they peg the GPU on high-refresh displays" applied concretely.
- **All in-flight states present as one "Working" pill.** `pending`/`running`/`waiting` collapse to a single steady state; detail belongs in the activity sub-line. Rationale: _"a stalled/waiting/queued subagent is still the fleet doing its job, not a user problem."_ Only settled states differentiate.

Structure: `PhaseRail` → `PhaseSection` per phase → `AgentRow` per agent; `ExpandedWorkflowSection` / `CollapsedWorkflowSection`; collapsed groups show a one-line summary with rolled-up tokens and elapsed time.

**`WorkflowScriptView`** fetches the workflow script through `orchestration.getWorkflowScript` — the comment notes this is deliberately _"never a raw filesystem read from the client."_ Even for a developer tool, the client doesn't get arbitrary FS reach; it goes through a contained, scoped RPC. Good instinct to inherit.

The chat timeline itself carries only **one CTA row per spawn batch** — the roster renders in exactly one place. That's the answer to "how do I show 20 agents without destroying the conversation."

## The five providers

`BUILT_IN_DRIVERS` in `apps/server/src/provider/builtInDrivers.ts`, ordered `[Codex, Claude, Cursor, Grok, OpenCode]` (order affects UI tie-breaking only).

| Driver        | Transport                          | Notes                                                                                                                                                                                       |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`       | `packages/effect-codex-app-server` | Richest integration: `CodexSessionRuntime`, `CodexCollabRuntime` + `CodexCollabWire` (collaboration/child-agent wire), `CodexDeveloperInstructions`, `CodexHomeLayout`, `codexModelOptions` |
| `claudeAgent` | `ClaudeAdapter`                    | `ClaudeCapabilitiesProbe` (feature-detects the installed CLI), `ClaudeExecutable`, `ClaudeHome`, `ClaudeSkills`                                                                             |
| `cursor`      | **ACP** (`packages/effect-acp`)    | `CursorAcpSupport` shim                                                                                                                                                                     |
| `grok`        | **ACP**                            | `GrokAcpSupport` shim; also `GrokTextGeneration`                                                                                                                                            |
| `opencode`    | `opencodeRuntime.ts` + CLI parsers | `makeManagedServerProvider` — managed server lifecycle                                                                                                                                      |

### `packages/effect-acp`

A first-class Effect implementation of the **Agent Client Protocol**, part generated (`_generated/schema.gen.ts`, `meta.gen.ts` via `@effect/openapi-generator`) and part handwritten (`client.ts`, `agent.ts`, `protocol.ts`, `rpc.ts`, `terminal.ts`, `errors.ts`, `_internal/stdio.ts`). There's an `acp-mock-agent.ts` script for testing without a real CLI.

**Strategic note:** ACP is an emerging open standard for editor↔agent communication. T3 betting on it means new ACP-speaking agents are close to free. If we want breadth of harness support cheaply, ACP is the lever, and `effect-acp` is a working reference.

### Driver contract

A driver declares `driverKind`, a `configSchema`, and a `create` returning a scoped adapter. Adding one:

1. implement `ProviderDriver` in `Drivers/<Name>Driver.ts`,
2. add it to `BUILT_IN_DRIVERS`,
3. ensure the runtime layer satisfies its declared `R`.

`BuiltInDriversEnv` is the union of every driver's env requirement; the registry layer's `R` is that union. Type-level enforcement that the runtime provides everything every driver needs — a missing service is a compile error, not a runtime crash.

Supporting machinery worth noting: `providerMaintenance` / `providerMaintenanceRunner` / `providerMaintenanceCommandCoordinator` (updating provider CLIs from inside the app), `providerStatusCache`, `providerSnapshot` / `unavailableProviderSnapshot` (a configured-but-missing driver degrades to a visible "unavailable" shadow rather than disappearing), and `ProviderSessionReaper` (cleans up orphaned sessions).

## What to take

1. **`TaskAgentLinkage` repeated on every lifecycle row.** Identity must survive retention eviction.
2. **Denylist classification with a server-side stamp.** Against a drifting third-party vocabulary, allowlists fail silently.
3. **Order-robust folding.** Completion can create an agent; a late start only fills metadata.
4. **Fixed-height agent rows, stable spawn order, one collapsed in-flight state.** The fleet view must be readable at 20 agents and must not thrash.
5. **DOM-write timers, no animated dots.** A fleet dashboard is the worst possible place for per-second React re-renders.
6. **`timelineBypass`.** Child-agent chatter must never flood the parent conversation.
7. **Contained RPC for artifact reads** (`getWorkflowScript`), not client filesystem access.
8. **Build the server-side projection, not the client fold** — that's where T3 itself is heading with orchestration-v2.
