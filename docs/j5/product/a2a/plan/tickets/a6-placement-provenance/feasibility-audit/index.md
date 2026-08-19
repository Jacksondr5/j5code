---
title: "A6 feasibility audit — placement integration boundary"
kind: spec
---

# A6 feasibility audit — placement integration boundary

Status: additive-composition feasibility spike authorized. Audited against worktree head `521c50aa9bb6b4c7f55bc10a772822ec31129f2d` on 2026-08-16.

## Finding

Strict FORK add-don't-modify makes the A6 acceptance criteria infeasible. A J5-owned projection can store an independent placement tree after a thread is created, but it cannot truthfully add placement to the real creation surface or make existing stop/archive cascades follow that tree.

| Required behavior | Current owner | Why J5-only code cannot supply it |
| --- | --- | --- |
| `placement` on agent/thread creation | `packages/contracts/src/orchestrationV2.ts`, `ThreadLaunchService`, `Orchestrator` | The v2 command schema and dispatch path own creation; `thread.create` currently builds root lineage directly. |
| Immutable spawn provenance | v2 creation commands/events | The source creation fact is emitted by v2, including delegated and fork paths; an after-the-fact J5 record cannot guarantee automatic, atomic provenance. |
| Cascade follows placement | `ThreadLifecycleService` and v2 archive/delete handling | Existing lifecycle commands act on a thread and have no J5 placement lookup/hook. |

There is a narrow composition seam, but it is not available under the no-protected-file-edit rule: MCP sessions already grant all capabilities, public `OrchestratorMcpService` methods compose over upstream creation, and per-thread lifecycle operations permit a J5 placement walk. Reaching a J5 tool still needs one protected appended registration entry in `McpHttpServer.ts`; built-in creation and native UI remain unchanged.

## Independent confirmation

The Builder independently confirmed the boundary at the same stationary head. The agent-facing creation inputs enter the protected `packages/contracts/src/orchestratorMcp.ts` (`OrchestratorMcpCreateThreadRequest` / `OrchestratorMcpThreadStartInput`); their handlers in `apps/server/src/mcp/OrchestratorMcpService.ts` dispatch v2 commands with no J5 hook. The client relationship view is also upstream-owned (`packages/client-runtime/src/state/threadRelationships.ts`) and derives v2 lineage, not a J5 placement projection. A separate J5 tool would therefore bypass the existing `delegate_task`, `create_threads`, and lifecycle paths and fail the A6 acceptance criteria.

## Decision needed

1. Authorize a narrowly-scoped integration exception for the v2 command schema plus creation and lifecycle dispatch hooks, explicitly preserving v2 delegation/result binding; or
2. Defer A6 until upstream supplies an extension seam.

Recommendation: defer rather than alter v2 for this ticket. The requested result is an actual display/cascade semantic change, not an appended reachability case.

## Director direction — composition spike

Protected upstream edits are refused. Before deferral, test only whether a J5-owned composition can truthfully provide a narrowed v1 surface:

- a J5 creation wrapper that invokes unchanged upstream creation and then records J5 placement;
- read-only provenance derivation;
- a J5 placement-tree walk that invokes existing per-thread upstream stop/archive commands.

The native UI and direct upstream creation paths retaining their default placement are an accepted, documented v1 boundary. This is a feasibility proof only: no protected-file edits and no substantive implementation until its verdict.

## Spike verdict

**FAIL under the Director's no-protected-file-edit rule.** The wrapper and placement cascade could compose existing public services, but cannot be registered in production without editing the protected MCP server merge. In addition, ordinary `thread.create` emits `lineage.parentThreadId: null`; immutable provenance can be derived read-only for delegated child threads but not ordinary threads. No proof test was warranted.

## Resumption boundary

The Director subsequently authorized one append-only, J5-commented MCP bootstrap registration, shared by A2 and A6. A2 owns the first landing because its authenticated send/reply surface requires it; A6 must not duplicate the bootstrap or edit `McpHttpServer.ts`, `server.ts`, or `FORK.md`. After A2 commits, A6 may add placement tools within the A2-owned `apps/server/src/j5/a2a/mcp/` toolkit.

The resumed A6 provenance model is explicit: delegated agents use immutable upstream lineage; J5 wrapper-created agents record their spawner; native ordinary creation is `unknown`. Native UI and direct upstream creation retain their default placement in v1.

## FORK inventory gate

Before either A2 or A6 shared-toolkit PR merges, the groups must publish and verify the complete measured inventory of protected upstream appends with file and line anchors. The Director set the scope to the entire A2A build against pin `993407dd9`, with exactly four retained exceptions:

1. A1 migration startup hook: `apps/server/src/persistence/Layers/Sqlite.ts:10` import and `:42` run.
2. One shared MCP integration instance: `apps/server/src/mcp/McpHttpServer.ts:31,247-248` and essential runtime wiring at `apps/server/src/server.ts:50,350-351`.
3. A2 replay-dedup test append: `apps/server/src/orchestration-v2/runtimeLayer.test.ts:188-234`.
4. A2 authenticated-tool/401 test append: `apps/server/src/mcp/toolkits/worktree/registration.test.ts:19-20,34-35,85-92,130-133`.

The A2 Builder owns the single `FORK.md` replacement; A6 must not edit it. The final inventory is exactly these four bare-clone-auditable anchors: A1 `Sqlite.ts:10,42`; shared MCP registration `McpHttpServer.ts:31,247-248`; the two A2 test appends listed above. `server.ts` is excluded as speculative. The record must use commit SHAs, in-repo file/line anchors, and `BRANDING.md` primary citations. Any retained Traycer/T1–T6 reference must state **`internal project records (not present in this repository)`**. A fifth server anchor requires a concrete failure without it, Reviewer necessity confirmation, and the Director's added authorization; a Reviewer dispute escalates. Re-measure the four anchors at the merge head; any unlisted protected edit blocks review and retirement.

The MCP anchor has one additional exact-shape check: `McpHttpServer.ts` may contain only the J5 registration import and one appended `Layer.mergeAll` entry. The registration layer itself must remain J5-owned in `apps/server/src/j5/a2a/mcp/registration.ts`; a fourth upstream toolkit-definition block is an unlisted protected edit and blocks retirement.

## Sequencing gate

A6 is **pre-PR/integration-cleared only**, not PR-ready. Its branch currently contains A2 history and has no open PR. A2 must complete its live proof, PR lifecycle, and merge first. Only then may A6 rebase its A6-only delta onto the fresh `j5/main`, repeat exact-head independent review and the FORK gate, and open a one-concern A6 PR. A2's unperformed live provider proof is A2's boundary and is not evidence of A6 readiness.

The rebase is semantic, not a standalone cherry-pick: the integration range modifies A1/A2-owned J5 files (handlers, toolkit, runtime, bootstrap, and ledger) and contains no new-file commits. After it, rerun the discriminating G1 ordering/no-side-effect, G2 historic-versus-never-joined, and G3 handler-branch controls; remeasure migration sequencing and the four-anchor gate against the new base; then obtain a fresh independent review.

## Open findings

| ID | Finding | Owner | Status |
| --- | --- | --- | --- |
| A6-F1 | D10/A6 says mutable-placement cycle checking can reuse a v2 relationship-graph approach. At this pin no cycle logic exists: v2 lineage is immutable and acyclic by construction. Any future mutable J5 placement pointer needs an explicit new cycle-check algorithm. | Spawner / future A6 | Open |
| A6-F2 | Fork provenance was not covered by the resumed delegated/wrapper/native trichotomy. Director ruling: use a separate immutable `forked-from` kind, never `spawned-by`; place a fork as a sibling of its source (same placement parent, otherwise root). | Builder | Resolved — board decision #3 |
