---
title: "A6 integration review — verdict at d44fad9ad (changes requested)"
kind: review
---

> **Terminology note (post-E6):** the grouping concept was renamed **epic → squadron** on 2026-08-17 (definition: `product/epic/`); the code rename landed in PR #8. "Epic" below is preserved as dated historical record — read it as "squadron." Filesystem paths are literal.

# A6 integration review — verdict

<user_quoted_section>Current verdict (fix round): CLEAN to open the PR at 87151a0a2137e4cff2d4f156d28ad789e2e37d54. G1, G2, G3, G5 resolved; G4's implementation is fixed but its test cannot fail, carried as one LOW. See §Fix round at the end. The round-1 detail below is the record of what was asked.</user_quoted_section>

**Reviewed SHA:** `d44fad9ad278d24ddf8c017d388934fe277e66ea` (working tree clean, HEAD confirmed).
**Diff under review:** `3152dc494..d44fad9ad` (A6 integration) plus the composed head's protected-file delta and cherry-pick mapping.
**Verdict:** **changes requested** — 1 high, 2 medium, 2 low.
**Core verdict at `e041f576` is unaffected** and remains clean (see `../reviewer-verdict-core/`). Everything below is new surface introduced by the integration commit.

## Actionable checklist

1. **G1 HIGH** — `stop_agent` / `archive_agent` accept any `epic_id` from any caller with no membership check; an agent can cascade-stop or archive subtrees in epics it does not belong to.
2. **G2 MEDIUM** — provenance can now record a synthesized participant id that never existed; the membership check that caught this was removed in the same commit, and neither path is tested.
3. **G3 MEDIUM** — one integration test; the caller-membership error branches and the enriched `placementParentId` are never exercised.
4. **G4 LOW** — the J5 runtime builds a second `ThreadLifecycleService` instead of the shared one.
5. **G5 LOW** — `clientRequestId` is loosened relative to upstream's constraint, letting upstream's dedup key and J5's placement command id disagree.

## Gates that pass, and how they were measured

**FORK / four-anchor gate: passes exactly.** The composed head's protected-file delta against the A1 base is precisely four files — `FORK.md`, `McpHttpServer.ts`, `worktree/registration.test.ts`, `runtimeLayer.test.ts` — and A1's `Sqlite.ts` hook is already in the base as inventory anchor 1. **The A6 integration diff itself touches zero protected files**, so A6 added no anchor and no duplicate registration, exactly as instructed.

Every anchor re-measured at this head rather than taken from the decision record:

| Anchor | Claimed                                    | Measured                                                                                                                                                                                         |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1      | `Sqlite.ts:10,42`                          | `:10` import, `:42` call — correct                                                                                                                                                               |
| 2      | `McpHttpServer.ts:31,247-248`              | `:31` is the `J5McpIntegrationLive` import (immediately after the last upstream import at `:30`); `:247` comment + `:248` entry inside `Layer.mergeAll`. Total protected delta 3 lines — correct |
| 3      | `runtimeLayer.test.ts:188-234`             | test `replays an internal thread send without injecting a second message` starts at `:188`, ends `:234` — correct                                                                                |
| 4      | `registration.test.ts:15,70,83-90,128-132` | all five regions match the appended lines exactly — correct                                                                                                                                      |

**Note for anyone comparing against board decision #9:** #9 recorded anchor 4 as `:19-20,34-35,85-92,130-133`. Those numbers were measured on A2's pre-composition head and shifted during cherry-pick. FORK.md's numbers are the correct ones at the merge head — this is the re-measure gate doing its job, not a discrepancy. FORK.md also anticipates future drift by naming the durable symbol/test alongside each line.

**FORK.md wording gate: passes.** Four per-instance cases, commit SHAs (`a064a87ac`, `521c50aa9`, `0c0de1ace`) rather than only line numbers, `BRANDING.md:1-5,24-35` for the excluded rebrand baseline, and external records labelled verbatim as "internal project records and are not present in this repository." Explicitly states A6 extends the J5-owned toolkit without another protected-file registration — which the diff confirms.

**Migration conflict resolution: correct.** `001_EpicCommunicationLedger` (A1), `002_SendDeliverReply` (A2), `003_ParticipantPlacement` (A6). A6's placement migration was renumbered 002→003, the file renamed, and `migrationEntries` matches. The J5 id space and tracking table stay independent of upstream's.

**Identity boundary: held at the strongest available level.** There is **no** reparent tool in `J5Toolkit`. Human-only re-parenting isn't defended by a runtime check on the agent surface — it simply has no agent surface, which is better than a guard. The service-layer caller union proven in the core round remains the enforcement point for the eventual UI path.

**Idempotency claim is true, not just asserted.** `OrchestratorMcpDelegateTaskInput` really does carry `clientRequestId` (`orchestratorMcp.ts:167`), so A6 making it required and passing it through means retries land on upstream's own dedup, and the J5 placement write is separately idempotent by derived command id. The test asserts the value reaches `delegateTask` unchanged. This was the specific claim in the tool description worth checking, and it holds.

**Reachability: proven at handler level.** The integration test drives all six tools through the real `J5Toolkit.handle` with a real `McpInvocationContext`, so toolkit composition and handler identity resolution are genuinely exercised.

**Baseline:** 45 tests pass across 11 files; `tsgo --noEmit` exits 0 with zero diagnostics.

## G1 — HIGH — cascade tools accept any epic from any caller

- **reviewed SHA:** `d44fad9ad` · **current:** `d44fad9ad` · **applicable:** yes
- **required:** `stop_agent` and `archive_agent` must resolve caller membership and refuse targets outside the caller's epic, the way `spawn_agent` already does.
- **mechanism:** both handlers (`mcp/handlers.ts`) take `epic_id` and `participant_id` straight from tool input and call `cascades.stop` / `cascades.archive` with no authorization step. The only downstream check is `ensureParticipant(epicId, participantId)` inside `listSubtree`, which is an _existence_ check — it succeeds precisely when the target is real. So an agent holding the J5 toolkit can name any epic on the host and cascade-stop or archive that subtree, leaves-first, across every agent in it. Both tools are annotated `Destructive: true`.
- **why this reads as an oversight rather than a decision:** `spawn_agent`, in the same file, does the opposite — it resolves `callerMemberships` from the invocation scope and fails with a state-naming `J5PlacementMcpStateError` when membership is missing or ambiguous. The cascade handlers were written without that step. The asymmetry inside one file is the tell.
- **the honest counter-argument:** everything runs single-host under one user, and epic scoping is arguably organizational rather than a security boundary — so the group may rule this an accepted v1 boundary. If so it should be _written down_, because the ticket already treats agent-callable boundaries as load-bearing (reparent is human-only precisely on those grounds), and a destructive cross-epic verb is the one place that reasoning is most likely to be revisited later.
- **suggested fix:** reuse the `spawn_agent` membership resolution, require `epic_id` to equal the caller's epic, and add the negative control — a caller in epic A naming epic B is refused. That control also discriminates, which today's test cannot: it only ever passes the caller's own epic.
- **owner:** builder · **status:** open

## G2 — MEDIUM — provenance can name a participant that never existed

- **reviewed SHA:** `d44fad9ad` · **current:** `d44fad9ad` · **applicable:** yes
- **required:** provenance must not record a fabricated participant reference; either resolve a real participant or record `unknown`.
- **mechanism:** two changes in this commit combine. First, `ensureJoinedPlacement` resolves the parent participant by searching the directory and, on miss, **synthesizes** one: `?? participantIdForThread(parentThreadId)`. Second, `recordCreation` lost its `ensureParticipant(input.epicId, provenanceParticipantId)` validation (`PlacementService.ts`, replaced by a comment). So a delegated child whose parent thread never joined the epic is stored as `spawned-by <synthesized-id>` where no such participant row exists, permanently and immutably. `list_participants` will then surface a provenance reference that resolves to nothing.
- **the rationale is half right:** the comment justifies the removal as "immutable lineage must not be erased merely because its source is absent or has since left membership." Referencing a _departed_ member is legitimate — that participant existed and the ledger has its `participant.joined`. Referencing an id that was manufactured client-side and never joined anything is different, and the removed check was the only thing separating the two cases. On the ticket whose central claim is truthful immutable provenance, that distinction is the whole point.
- **untested either way:** no test covers the synthesized-fallback branch or a non-member provenance id. The behavior change to core `PlacementService.ts` arrived in an integration commit with no accompanying test.
- **suggested fix:** keep the relaxation for ids that exist in the ledger's membership history (including departed members), and fall back to `{kind:"unknown"}` rather than a synthesized id when the parent was never a participant. Test both branches.
- **owner:** builder · **status:** open

## G3 — MEDIUM — one integration test, with the interesting branches uncovered

- **required:** cover the caller-membership refusals and assert the enriched fields the tool contract promises.
- **mechanism:** `handlers.test.ts` adds a single test. Not exercised: `J5PlacementMcpStateError` for **missing** caller membership, the same for **ambiguous** membership across epics (both are the authorization logic G1 says should also guard the cascade tools), the `not-applicable` provenance for the human participant, and `placementParentId` — which `J5ParticipantDirectoryRow` adds to the tool's success schema and which no assertion ever reads. The single provenance assertion checks `participants[0].provenance.kind === "unknown"`; it does discriminate that the placement lookup happens at all (a dropped lookup would yield `unrecorded`), so it isn't vacuous — but it is the only enrichment claim under test.
- **a caveat on what the mocks can prove:** the `ParticipantPlacementService` mock derives `placementParentId` from the provenance kind itself, so any assertion on that field would be checking the mock's arithmetic rather than the handler's mapping. Asserting enrichment meaningfully needs either the real service or a mock whose placement parent is independent of provenance.
- **owner:** builder · **status:** open

## G4 — LOW — a second `ThreadLifecycleService` instance

`runtimeLayer.ts` wires the cascade layer as `placementCascadeLayer.pipe(Layer.provide(threadLifecycleLayer), …)`, constructing its own `ThreadLifecycleService` rather than consuming the shared runtime's. The service is a thin dispatch wrapper over `ThreadManagementService` — which does stay shared — so behavior should be identical today. But the file's own comment says "SQL and V2 thread management stay shared runtime dependencies," and this quietly diverges from that. Either consume the shared instance or note why a local one is fine.

## G5 — LOW — `clientRequestId` is loosened against upstream's constraint

`J5SpawnAgentInput` overrides the spread field with `Schema.String.check(Schema.isNonEmpty())`, while upstream's `OrchestratorMcpClientRequestId` is `TrimmedNonEmptyString` capped at 256 (`orchestratorMcp.ts:44-46`). Concrete divergence: for `" k"` versus `"k"`, upstream trims and treats them as the same dedup key — returning the same child — while J5 embeds the raw value in `placementCommandId`, producing two different command ids. The second call then attempts a fresh placement write for a child that already has one and fails with `PlacementAlreadyExistsError`. Obscure, but it is exactly the retry path the required `clientRequestId` exists to make safe. Reusing upstream's schema for the field removes it.

# Fix round — re-review at `87151a0a` (clean to open)

**Reviewed SHA:** `87151a0a2137e4cff2d4f156d28ad789e2e37d54` · tree clean, HEAD re-confirmed after mutation.
**Diff:** 9 J5-only files from `d44fad9a`. **Protected delta unchanged** — still exactly `FORK.md`, `McpHttpServer.ts`, `worktree/registration.test.ts`, `runtimeLayer.test.ts`, so the four-anchor inventory is untouched and A6 still adds no anchor. Anchors re-measured: all four still correct at this head.
**Baseline:** 47 tests across 11 files pass; `tsgo --noEmit -p apps/server` exits 0 with zero errors.

| ID            | Status                                         | Verified how                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** HIGH   | **resolved**                                   | `requireCallerInEpic` runs as the first statement in both cascade handlers — before `yield* PlacementCascadeService`, so denial precedes service acquisition _and_ dispatch, as decision #13 required. Errors name the state and the next command with concrete epic ids. The test drives cross-epic `stop_agent` and `archive_agent` and asserts `cascadeCommands` still holds only the 2 legitimate earlier calls — a real no-side-effect assertion that would read 4 if the check ran after dispatch.                                                                                                                         |
| **G2** MEDIUM | **resolved, with defense in depth**            | The synthesized id is gone; the handler resolves via `ledger.findHistoricalAgentParticipantId`, which returns null unless exactly one distinct participant matches — so an ambiguous history yields `unknown` rather than a guess. Independently, `recordCreation` regained `ensureProvenanceParticipant`, which checks the ledger's `participant.joined` history rather than current membership: a departed member passes, a never-joined id is refused. That is exactly the historic-departed vs never-joined split. Bonus fix I hadn't asked for: a departed spawner now placed at `root` rather than failing `ensureParent`. |
| **G3** MEDIUM | **resolved**                                   | Missing-membership and ambiguous-membership branches now tested with message assertions naming the epics. `placementParentId` enrichment is asserted against a directory-independent `displayParentId`, so it checks the handler's mapping rather than mock arithmetic — the specific weakness I flagged. Human row asserted as `not-applicable` with a null parent.                                                                                                                                                                                                                                                             |
| **G5** LOW    | **resolved**                                   | `clientRequestId` now reuses upstream's own schema via `Schema.required(OrchestratorMcpDelegateTaskInput.fields.clientRequestId)`, so normalization is upstream's by construction and the dedup key can no longer diverge from the J5 placement command id.                                                                                                                                                                                                                                                                                                                                                                      |
| **G4** LOW    | **implementation fixed; its test cannot fail** | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## G4 (carried) — the lifecycle-reuse test does not discriminate

- **reviewed SHA:** `87151a0a` · **applicable:** yes · **severity:** LOW, non-blocking
- **required:** prove production consumes the _shared_ `ThreadLifecycleService` rather than the standalone fallback.
- **the implementation is right:** `sharedThreadLifecycleOrStandaloneFallback` prefers `Effect.serviceOption(ThreadLifecycleService)` and falls back to `ThreadLifecycle.make` only for isolated layers. No objection to the design.
- **but the test proves something weaker than it appears.** `runtimeLayer.test.ts` provides a counted lifecycle mock, adds a second consumer, and asserts `threadLifecycleBuilds === 1`. Layer memoization makes that count 1 whenever the counted layer is demanded at all — including when the J5 runtime ignores it and builds its own instance via the fallback, because the second consumer alone still triggers exactly one build.
- **proven by mutation:** I deleted the shared branch outright, leaving `return yield* ThreadLifecycle.make` so the runtime _always_ builds a standalone instance. **The test still passed.** Restored; tree clean. So the assertion cannot fail in the scenario it exists to rule out, and the reuse claim is currently unverified.
- **why it stays LOW:** `ThreadLifecycleService` is a thin dispatch wrapper over `ThreadManagementService`, which does remain shared and _is_ proven shared by the same test's `threadManagementBuilds === 1`. A duplicate wrapper would be wasteful, not incorrect.
- **suggested fix:** make the shared instance observable rather than counted — give the counted mock an `archive` that records calls and assert a cascade dispatch arrives at _that_ instance; or count `ThreadLifecycle.make` invocations and assert zero when a shared service is in context.
- **owner:** builder · **status:** open (non-blocking)

## Untested boundary — unchanged and disclosed

Live provider-to-provider MCP evidence remains **unperformed**, awaiting dashboard ask #2. Everything proven here is handler-level: the toolkit dispatches, handlers resolve identity from the invocation scope, and composition typechecks against the real upstream services. That is not the same as an agent on one provider actually driving these tools against another provider over the authenticated transport. The distinction matters most for `spawn_agent`, whose upstream dedup behavior under real retry is asserted by contract inspection here, not observed.

No claim in this verdict should be read as end-to-end proof.
