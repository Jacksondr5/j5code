---
title: "A2 gate — how upstream dedup actually works at pin 521c50aa9"
kind: spec
---

# Upstream exactly-once mechanics (reviewer-verified)

Authored by the A2 Reviewer, 2026-08-16, from the tree at `521c50aa9` (A1 merged, no A2 code yet).
Independent read of upstream source; not a summary of the Builder's gate report. Written down because
the A2 plan and ticket state the mechanism inaccurately, and because two of the failure modes below
are invisible to a first-pass test.

## Correction to the plan text

`plan/index.md` §Message pipeline and the A2 ticket both say the worker "derives v2's `clientRequestId`
deterministically from the ledger message id."

**`clientRequestId` does not exist on the internal path.** It is an MCP-surface concept only.
`ThreadManagementSendInput` (`apps/server/src/orchestration-v2/ThreadManagementService.ts:100`) has no
such field. `OrchestratorMcpService.sendToThread` (`apps/server/src/mcp/OrchestratorMcpService.ts:1567`)
converts it into a `commandId` + `messageId` via `stableCommandId` (line 425) and
`stableOperationMessageId` (line 475) before calling the internal service.

The gate's intent still holds — the internal path _is_ deterministically dedupable — but the key is the
**`commandId`**. A2 derives `commandId` (and `messageId`, see below) from the ledger message id and
calls `ThreadManagementService` directly. Routing through the MCP tool surface to reach a dedup key that
can be set directly would be a workaround.

## Where dedup lives

| Layer              | File                                                         | Behavior                                                                                                                            |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Dispatch guard     | `Orchestrator.ts:6847-6904`                                  | Reads `commandReceipts.getByCommandId` **before** planning. Accepted receipt → returns stored events, never re-plans or re-commits. |
| Commit guard       | `EventSink.ts:394-411`                                       | `insertIfAbsent` on the receipt; loser returns `committed: false` with the original stored events.                                  |
| Cross-thread guard | `Orchestrator.ts:6880`, `canReplayCommandReceipt` (line 152) | A receipt may only be replayed for the thread it was recorded against; otherwise `OrchestratorCommandIdConflictError`.              |

Receipt retention is safe: `ProjectionMaintenance.ts:361-375` prunes
`orchestration_command_receipts`, but only `command_type = 'legacy'` rows on fully-imported v1 threads.
A2's receipts are never pruned, so "upstream dedup is the guarantee" does not decay over time.

## Two failure modes that pass a naive test

### 1. `messageId` must be deterministic, not just `commandId`

After the Orchestrator dedups, `ThreadManagementService.sendToThread` still resolves the message out of
the projection by id:

```
projection.messages.find(c => c.id === input.messageId)     // line 512
→ undefined ⇒ ThreadManagementDurableRunProjectionError      // lines 528-537
```

A deterministic `commandId` paired with a fresh `messageId` therefore **fails on replay** — precisely the
crash-window re-drain the acceptance criteria exist to prove — while a happy-path test still passes.
Both ids must be functions of the ledger message id.

### 2. A rejected receipt permanently poisons its `commandId`

`Orchestrator.ts:6867-6875`: an existing receipt with `status === "rejected"` fails with
`OrchestratorCommandPreviouslyRejectedError` on every future dispatch of that id. Rejected receipts are
written by the `Effect.catch` at lines 6918-6941 for **any** typed `OrchestratorV2Error` raised during
planning — including `OrchestratorProjectionError`, i.e. a transient storage failure, not only a
semantic refusal.

This forces a retry-design choice that must be made explicitly:

| Option                                | Guarantee           | Cost                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable `commandId` across all retries | Strict exactly-once | A transient planning failure is terminal for that message; must surface as the alarm state, never an infinite loop against a poisoned id                                                                                                                                                                                                                                           |
| Per-attempt `commandId`               | Survives poisoning  | Attempt counter must be durably committed (`message.delivery_failed`) _before_ the next attempt, or a crash-window re-drain bumps the attempt and double-injects. **Residual hole:** `sendToThread` can fail _after_ `commitCommand` succeeded (projection check, lines 528-537), so a recorded failure does not prove nothing was injected — bumping the id there double-injects. |

## A1 carry-forwards that land on A2

- **The `A2ALedger` layer is not provided at runtime.** Outside `src/j5/a2a/`, the only reference to J5
  A2A code is `persistence/Layers/Sqlite.ts:10`, which runs migrations. A1 shipped tables without a
  runtime service. A2 owns the wiring.
- **Receipt rollback needs a committed regression.** `LedgerService.ts:267-283` reserves the receipt row
  before inserting the event, inside one transaction. A2's `message.received` path can fail that insert
  on the unique index (`migrations/001_EpicCommunicationLedger.ts:41-45`). If the receipt ever survived a
  failed event insert, a replayed `commandId` would return a receipt pointing at a nonexistent event.
  A1 only probed this with a throwaway.
- **`readEvents` gap contract.** `LedgerService.ts:451` raises `LedgerGapError` when a page returns empty
  while `afterSeq < snapshotEnd`. A drain loop that filters by kind in SQL while reusing this cursor
  contract will trip it.

## The authorized MCP registration case (Director ruling, 2026-08-16)

A2 and A6 share **one** append-only registration case in `apps/server/src/mcp/McpHttpServer.ts`, plus
`server.ts` only if essential, J5-commented and recorded in FORK.md. Baseline at `521c50aa9` so the
"append-only" shape is measurable:

| Element                                     | Baseline location                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Toolkit + handler imports                   | lines 17-29                                                                                                            |
| One registration const per toolkit          | `PreviewToolkitRegistrationLive` 220, `OrchestratorToolkitRegistrationLive` 225, `WorktreeToolkitRegistrationLive` 230 |
| Transport, carrying `McpAuthMiddlewareLive` | 235-240 — auth applies to anything in the final mergeAll                                                               |
| `export const layer = Layer.mergeAll(...)`  | 242-246                                                                                                                |

In-bounds diff: **2 import lines + 1 exported const + 1 appended mergeAll entry.** Reordering the
mergeAll, restructuring `McpTransportLive`, or touching auth middleware is outside the ruling.

Settled between the A2 and A6 Sitters (dashboard decision #2): **A2 lands the shared bootstrap first**,
and A6 adds its tools into A2's J5-owned `apps/server/src/j5/a2a/mcp/` toolkit afterwards, making zero
further protected-file registration edits. That makes the aggregate shape a contract, not a preference:
`McpHttpServer.ts` gets one appended entry pointing at a J5-owned aggregate layer (one
`J5ToolkitRegistrationLive` merging J5 toolkits internally), extensible from inside `j5/a2a/mcp/` alone.
`McpServer.toolkit()` returns a plain Layer whose `McpServer` requirement is already satisfied by
`Layer.provideMerge(McpTransportLive)` at 246.

Two boundaries that are _not_ covered by the ruling:

- **Capabilities.** `McpInvocationContext.ts:10` is `ALL_MCP_CAPABILITIES = ["preview","orchestration", "worktree"]`. Adding an `"a2a"` capability edits a third protected file — a Sitter-routed DECISION.
  Note `requireMcpCapability` (line 27) is hardcoded to `"preview"`; the orchestrator and worktree
  toolkits authorize by thread scoping (`loadScopedThread`) instead, which is the in-bounds pattern.
- **The delivery worker does not belong in the MCP registration.** It needs startup reconciliation and a
  background drain, so it belongs in the runtime: one appended `Layer.provideMerge` alongside
  `RuntimeCoreDependenciesBaseLive` (`server.ts:346`), where `SqlClient` (via `PersistenceLayerLive`, 354. and `ThreadManagement` (via `OrchestrationApplicationLayerLive`, 341) are both visible. Hiding a
  background worker inside the MCP toolkit layer to avoid the `server.ts` line would tie its lifecycle to
  the MCP transport — gaming the constraint rather than honoring it.

**Sender identity is a security boundary.** `McpInvocationScope` (`McpInvocationContext.ts:13`) carries
`threadId`, `environmentId`, `providerSessionId`, `providerInstanceId`. The J5 `send_message` tool must
resolve the sender from `McpInvocationContext.threadId` and never from a caller-supplied field. A
`from`/`sender` tool parameter would let any agent attribute a message to any participant, in a ledger
whose whole purpose is to be authoritative about who said what.

## Tooling note

`grep` here is **ugrep**, which flags `apps/server/src/orchestration-v2/Orchestrator.ts` and
`ProviderSessionManager.ts` as binary and skips them silently without `-a`. Since Orchestrator.ts holds
the entire dedup mechanism, a search for `commandId` without `--binary-files=text` returns a clean,
confident, wrong answer.
