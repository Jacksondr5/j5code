---
title: "T3 orchestration-v2: what it is, why, and how far along"
kind: spec
---

# Orchestration-v2 (researched 2026-08-14, subagent read of main `196c8ea0d` + branch `t3code/codex-turn-mapping` @ `77168d081`)

## What it is

A ground-up rewrite of T3's agent orchestrator (not the whole platform), living on the long-running branch `origin/t3code/codex-turn-mapping` — draft **PR #2829**, ~230 commits ahead, open since 2026-05-27, still updated daily. Design docs: `docs/orchestration-v2/` (9 files, branch only); migration roadmap: `.plans/21-orchestration-v2-application-integration.md`; checklist: `apps/server/src/orchestration-v2/TODO.md`.

Core shape: a server-owned **execution graph** replacing v1's turn model. New first-class, replayable entities: `AppThread → Run → RunAttempt → ExecutionNode` (tools/approvals/subagents as a tree), plus `ProviderSession/Thread/Turn`, `Checkpoint`, `ContextTransfer/ContextHandoff`. App IDs primary, provider IDs refs; only root-run completion completes a user-visible turn. New contracts (`orchestrationV2.ts`, `orchestratorMcp.ts`), own event tables (migrations 041–049). **Server-side projections replace client folds** — including `SubagentProjection.ts`, the thing main's 940-line client bridge fold exists to be deleted for. All five provider adapters rewritten against `ProviderAdapterV2` with an explicit capability system (e.g. `supportsMultipleProviderThreadsPerSession`).

## Why

v1 conflated app runs, provider turns, and execution nodes; provider protocol realities (child completes before parent, interrupts terminating later, provider-initiated approval RPCs) couldn't be represented. PR #2829 closes ~35 issues — stuck-"Working" threads after restart (#4584/#4561), stuck after interrupt (#4713), reaper killing in-flight subagent work (#4198), plus features v1 can't express: mid-conversation provider/model switch (#3797/#4232), fork-from-message (#1404), delegation (#3138), steer/queue modes (#231).

## How far along

- **Main today**: v1 in production + deliberately v2-shaped bridge code (field names frozen to match v2 "so the migration is a rename, not a remap"; `ChatView.tsx` hardwires `v2Projection = null` "until orchestration-v2 lands").
- **Branch, per its own plan status**: Shapes 1–4.5 all "complete" — including the **v2-only backend hard cut deleting v1 server code** and full web+mobile cutover with v2-native UI (relationship graph, fork/merge-back, provider-switch). Remaining: projection hardening edge cases, portable cross-provider handoff, capability audit, subagent graph modeling.
- **No feature flag by design** — the plan forbids dual-write; Shape 3 "intentionally breaks the old client protocol." **Stage 5 (migrating existing v1 user state) is explicitly undecided**; release gate is fresh-state-only. A `LegacyV1ThreadImporter` exists (#4400).
- **Pace**: monthly commits Apr 19 → Jul 109 → Aug 43 (mid-month); repeatedly reconciled with main (latest 2026-08-14); new features now built directly on the branch (#5589 worktrees, #5544 thread handoff, #5499 session import, #5003 GitHub waitpoints). Read: feature-complete per its own plan; blocked on giant-PR review + the deferred data-migration decision. **Horizon: weeks-scale.**

## Relevance to our fleet manager

v2 is T3 moving toward first-class multi-agent orchestration itself:

- **Server-side subagent model**: reusable identity + per-activation records, roles, cumulative usage with per-provider merge semantics (Codex max-merge vs Claude delta-accumulate), `idle` as a real state, own projection table.
- **Orchestrator MCP server** (`orchestratorMcp.ts`): agents orchestrate agents via app-owned tools — `delegate_task` (spawn a child thread on _any_ provider, durable result), `task_status/cancel`, `create_threads`, `t3_thread_start/list/read/send/wait/interrupt` (send modes auto/queue/steer/restart), scheduled tasks, per-session scoped bearer creds. Their docs muse about exactly our product: "tools that let agents spawn subagents of other providers powered by the T3 Orchestrator."
- **Fleet primitives**: environment-scoped cycle-safe relationship graph (root/parent/child/fork/subagent/merge-back edges + statuses), `ContextTransfer` powering fork, merge-back, provider switch, and device handoff.
- **Durability patterns to steal**: durable effect outbox instead of reactor subscriptions, replay-backed integration tests, startup reconciliation (cancel in-flight provider subtrees atomically, resume queued turns).

## Implication for the fork decision (Director's note)

The fork-viability recommendation ("fork main now, build the v2-shaped projection ourselves, no v2 roadmap exists") was written believing v2 had no roadmap — in fact v2 is near-complete on a branch and lands as a **deliberate breaking hard cut**. Forking main now means absorbing that hard cut as a massive rebase within weeks, or building on v1 code the upstream is about to delete. Options: (a) hold fork execution until #2829 merges (do product/design/load-test work meanwhile), (b) fork the branch (risk: it's a moving draft), (c) fork main and accept the rebase. Timing addendum requested from the T3 researcher.

## Verification: peer agents and roles (Director, direct read of branch @ `77168d081`)

**No peer-agent concept exists.** The only "peer" mentions in v2 docs/contracts are JSON-RPC transport peers in the testing doc. The model is strictly a tree: `delegate_task` requires an active parent run; `task_status` rejects task IDs from another parent thread; lineage is `subagent` pointing back to the parent node; "sibling" in the adapters refers to provider threads sharing a CLI process, plus the "app-owned wake" — the orchestrator injecting a completion notice _into the parent_ when a delegated child finishes. **Nuance:** `t3_thread_list/read/send` are _project-scoped_, so an agent can inject messages (auto/queue/steer/restart) into any thread in its project, marked `createdBy: "agent"`, `creationSource: "mcp"`. That is thread-injection capability, not a peer conversation model — you address a thread, not an agent; the recipient gets no sender identity beyond provenance, no reply channel, no reply obligation, no silence semantics. Traycer-style peer A2A (typed silence, responseId threads, inbox, awaiting-input) remains entirely ours.

**Roles are one sentence of prompt text.** `role?: "implementation" | "research" | "review" | "design" | "test" | "general"` on `delegate_task`; the entire server-side consumption is `OrchestratorMcpService.ts:505`: `Act as the ${input.role} sub-agent for this task.` prefixed to the child's prompt, plus a label carried on the subagent activation projection for display/grouping. No registry, no reusable definitions, no capability binding, no standing instructions, no roadmap mentions beyond this. Combined with Traycer's role _claims_ (runtime dedup only), no one has the agent-type _definition_ layer in our backlog.

_Caveats: shape-status lines are the plan's self-report; test suite not independently run; ship-vs-migrate for existing users undecided upstream._
