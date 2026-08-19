---
title: "A6 reviewer verdict — feasibility seams, independently measured"
kind: review
---

# A6 reviewer verdict — feasibility seams

Independent scrutiny of the A6 feasibility question, per the Reviewer brief ("scrutinize the feasibility decision first"). Measured read-only against worktree head `521c50aa9bb6b4c7f55bc10a772822ec31129f2d` on 2026-08-16. No tree was reviewed for code quality — the Builder holds the baton for the Director-authorized composition spike.

Companion: `../feasibility-audit/` (Sitter + Builder audit). This artifact **partially refutes** it. Where the two disagree, the disagreement is about whether a seam exists, not about what upstream owns.

## Verdict

**A6 is feasible under strict FORK add-don't-modify**, in the narrowed form the Director authorized. The audit's blocking premise — "No J5 extension seam was found in these paths" — does not hold at this head. Two of its three infeasibility rows do not survive checking.

The genuinely infeasible parts are narrower than "A6", and both are already inside the Director's accepted boundary:

- built-in `delegate_task` / `create_threads` / `t3_thread_start` cannot gain a `placement` parameter (their inputs live in protected `packages/contracts/src/orchestratorMcp.ts`);
- J5 placement has no native UI effect (the client graph derives v2 lineage — confirmed below).

## Seams, measured

| #   | Seam                                               | Evidence at head `521c50aa9`                                                                                                                                                                                                                                                                   | Cost to upstream                                                                       |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | J5 MCP toolkit needs no capability-contract change | `McpSessionRegistry.ts:131` issues every scope `new Set(ALL_MCP_CAPABILITIES)`; the only `requireMcpCapability` caller in the tree is preview (`toolkits/preview/handlers.ts:40`). Orchestrator and worktree toolkits are ungated.                                                             | none                                                                                   |
| 2   | Toolkit registration                               | `McpHttpServer.ts:225-245` — `McpServer.toolkit(X).pipe(Layer.provide(XHandlersLive), Layer.provide(XService.layer))` plus one entry in the final `Layer.mergeAll`                                                                                                                             | one import + one list entry (same shape as A1's `persistence/Layers/Sqlite.ts` append) |
| 3   | Creation by composition, not extension             | `OrchestratorMcpServiceShape` exposes `delegateTask(scope, input)` (`OrchestratorMcpService.ts:97`) and `createThreads` (`:109`) as public methods over `McpInvocationScope`; a J5 handler layer provides `OrchestratorMcpService.layer` exactly as `OrchestratorToolkitRegistrationLive` does | none — calling upstream is not modifying it                                            |
| 4   | Placement-following cascade                        | `thread.archive` (`contracts/orchestrationV2.ts:1970-1973`) carries a single `threadId`; `ThreadLifecycleService.archive` (`:40, :91`) is a per-thread dispatch; `ThreadManagementService` has no child walk (only an already-archived check at `:469`)                                        | none                                                                                   |
| 5   | Provenance without a write hook                    | `OrchestrationV2AppThreadLineage` (`contracts/orchestrationV2.ts:81-84`) — `parentThreadId` / `relationshipToParent` / `rootThreadId` — recorded by upstream at creation, carried on the thread projection (`ProjectionStore.ts:865`)                                                          | none — read-only derivation                                                            |

## Where the audit's rows fail

**Row 2, "Immutable spawn provenance — an after-the-fact J5 record cannot guarantee automatic, atomic provenance."** Correct about a J5 _write_, but J5 does not need to write it. Upstream already records the spawn fact immutably at creation (seam 5). Deriving provenance read-only from lineage is automatic and atomic _because upstream's own creation transaction is_, and it covers every spawn — including ones made through built-in tools a J5 wrapper never sees. This is strictly better coverage than a wrapper-written row, which is exactly the version that would have the gap the row describes.

**Row 3, "Cascade follows placement — existing lifecycle commands have no J5 placement lookup/hook."** The mechanism is right and the conclusion inverts it. Upstream archive has **no cascade at all** (seam 4), so there is no existing cascade to redirect and no upstream semantic to override. A6's cascade is a _new J5 command_ that walks the J5 placement tree and issues N unchanged per-thread archive calls. The absence of an upstream hook is what makes this additive, not what blocks it.

**Row 1, `placement` on creation, stands.** The agent-facing inputs are protected-contract types. Upheld.

**Client-runtime finding, stands and is confirmed.** `deriveThreadRelationshipGraph` in `packages/client-runtime/src/state/threadRelationships.ts` builds the relationship graph from `thread.lineage`; the file is protected. J5 placement therefore cannot move anything in the native UI, and `list_participants` is the only honest read surface for it. Good catch; it is the sharpest constraint in the audit.

## Governing-artifact error — cycle checking

D10 (`../../../../index.md`) and the A6 ticket both direct re-parent cycle checking to "reuse the approach" because "v2's relationship graph already is" cycle-checked.

**It is not.** `grep -rni 'cycle' apps/server/src packages/contracts/src --include='*.ts'`, minus `lifecycle`/`recycle`, returns four hits, all unrelated (a pullRequest comment walk, two import-cycle comments). The reason none exists: v2 lineage is set at creation and never mutated, so the graph is acyclic **by construction**. A6's mutable display pointer is the first mutable parent edge in the system, which is precisely why it needs a real check — walk-to-root with a visited set and a depth bound, written from scratch.

Recorded here because a false "this already exists" line in a governing artifact costs a future reader a search that terminates in nothing.

## What the spike must not claim

Held for the stationary handoff review:

1. That the built-in creation tools accept placement. They do not and will not in v1.
2. That placement moves anything a user sees natively. It does not.
3. That provenance is guaranteed for spawns made outside a J5 wrapper — unless provenance is derived from lineage (seam 5), in which case it is, and the writeup should say which mechanism it relies on.
4. A discriminating cycle negative control (an attempted cycle rejected with a state-naming error) and an agent-caller rejection are acceptance criteria, not nice-to-haves; a test that only proves the happy path proves nothing about either.

## Simplification pushed to the Builder

**One** mutable J5 placement row keyed by threadId, where NULL means "follow provenance". That is the smallest model that makes all three of D10's relationships independently true. A design that writes an explicit placement row for every spawn duplicates what is already derivable and creates a second write path to keep consistent — it would come back as a finding.

# Addendum — Director ruling (2026-08-16)

The Director resolved A6 under existing FORK.md, matching the feasibility finding above. Three changes to the review gate.

## 1. Provenance trichotomy — supersedes "derive everything"

My original recommendation (derive provenance from lineage for every spawn) is **withdrawn**; the ruling is stricter and correct. Only three code paths write lineage in the whole tree, which makes the mapping mechanical rather than a judgment call:

| Upstream fact                                     | Provenance                                  | Writer                              |
| ------------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| `relationshipToParent === "subagent"`             | derived: spawner = `lineage.parentThreadId` | `SubagentProjection.ts:64`          |
| J5 wrapper performed the create                   | recorded: spawner = calling thread          | J5-owned                            |
| `relationshipToParent === null` (ordinary/native) | **explicit `unknown`**, never inferred      | no writer — root lineage by default |
| `relationshipToParent === "fork"`                 | **open — see §4**                           | `ThreadForkService.ts:74`           |

## 2. The inference trap this ruling exists to prevent

Native top-level creates _do_ leave a parent linkage in the v2 stream — just not in lineage. `OrchestratorMcpService.ts:1437` dispatches `thread.created.record` with `parentThreadId: scope.threadId` for `create_threads` / `t3_thread_start`, materializing a `thread_created` turn item in the caller's timeline (`contracts/orchestrationV2.ts:1022-1027`).

- Reading `thread.lineage` → native create yields `null` → correct `unknown`.
- Reading `thread.created.record` commands or `thread_created` turn items → native create yields the caller → **inferred spawner, forbidden**.

Both plausibly answer "who created this thread." One is recorded lineage, the other a timeline breadcrumb.

**Required discriminating control:** a fixture exercising only `delegate_task` passes under _both_ the correct and the forbidden implementation. The control that discriminates is a `create_threads` / `t3_thread_start` spawn of B from A asserting `provenance(B) === unknown` and specifically not A, paired with a delegated case asserting `provenance(child) === parent`. Neither test alone separates the implementations.

## 3. Registration lane — A2 owns it

A2 lands the single shared J5 MCP toolkit bootstrap; A6 adds placement tools to that toolkit afterwards. For A6 this inverts the FORK gate: any A6 edit to `McpHttpServer.ts`, `server.ts`, or FORK.md's appended-case inventory is a **finding** (duplicate registration / out-of-lane), not something to verify as well-formed.

For the record, `server.ts` needs no edit for any of this: `McpHttpServer.layer` is consumed at `server.ts:442`, and toolkit registration happens inside that layer's `Layer.mergeAll` (`McpHttpServer.ts:241-245`). "Strictly necessary" does not hold against that evidence.

## 4. Fork provenance — SETTLED (board decision #3)

Provenance is **typed**, not a nullable parent id: `spawned-by` (delegated lineage or J5 wrapper), `forked-from` (immutable fork lineage source parent), `unknown` (ordinary native / legacy null). Fork placement defaults to **sibling of source** — same placement parent, root if the source has none — never child of source.

Sharper than my `unknown` recommendation: it keeps the fork fact instead of discarding it, while still refusing to read a "copied from" edge as a spawn edge.

### The two tempting-but-wrong signals

**`parentThreadId` does not discriminate.** `ThreadForkService.ts:72-79` gives a fork `parentThreadId: source.id` _and_ `relationshipToParent: "fork"` _and_ `forkedFrom: {type:"run", ...}`. A fork carries a non-null lineage parent exactly like a delegated child. Keying on `parentThreadId !== null` coerces forks into `spawned-by` — the named failure. The discriminator is `relationshipToParent`.

**`rootThreadId` contradicts the placement rule in one case.** A fork inherits the source's root (`ThreadForkService.ts:75`), not self. For a source S that is itself root: upstream says the fork's `rootThreadId` is S, while the ruling says sibling-of-S → S has no placement parent → the fork is **root**. An implementation reading `rootThreadId` as a placement hint places the fork **under S**, the forbidden "child of source", and only in this case.

### Controls — which ones actually discriminate

| Control                                                                                              | Discriminates?                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| delegated → `spawned-by` **and** fork → `forked-from`, cases identical except `relationshipToParent` | **yes** — fork-only passes under "everything is `forked-from`"; delegate-only passes under "everything is `spawned-by`" |
| fork of a **root** thread → placement root, not child of source                                      | **yes** — a fork of a non-root source passes under both correct and `rootThreadId`-derived implementations              |
| reparent S under X, then fork S → fork's placement parent is X                                       | **yes** — proves sibling is computed from _placement_, not provenance                                                   |
| native create → `unknown`                                                                            | confirms (see §2 for the control that discriminates this one)                                                           |

### Consequences to document

- **Cascade:** placement-following cascade plus fork-as-sibling means archiving/stopping S **does not** cascade to S's forks. Deliberate, but reads as a bug if unstated — the ticket already requires cascade semantics in the command contracts, and this case should be named there.
- **Snapshot, not alias:** a fork takes its own placement pointer at fork time; later re-parenting of S does not move existing forks.
- **No legacy branch:** `LegacyV1ThreadImporter.ts:170-173` writes `parentThreadId: null, relationshipToParent: null` — the same shape as an ordinary native create. One `unknown` branch covers both; a `historyOrigin: "v1_import"` check would be dead logic.
