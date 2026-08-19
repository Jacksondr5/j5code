---
title: "A6 core review — verdict at d65acfdca (changes requested)"
kind: review
---

# A6 core review — verdict

**Current verdict (round 2): CLEAN — all six findings resolved at `e041f57613b713c520be9f1b7efe57036d05db36`.** See §Round 2 below. Round 1 detail is retained underneath as the record of what was asked and why.

**Round 1 reviewed SHA:** `d65acfdca92c221982b932c65944976ccda78a3f` (measured clean; `git status` empty, HEAD confirmed before and after review).
**Scope (both rounds):** J5 placement/provenance/reparent/cascade core only. A2's shared MCP bootstrap was **not** reviewed in either round and is not folded into either verdict — see §Untested integration boundary.
**Round 1 verdict:** changes requested — 3 medium, 3 low, no high.

# Round 2 — re-review at `e041f576` (clean)

**Reviewed SHA:** `e041f57613b713c520be9f1b7efe57036d05db36` · working tree clean, HEAD re-confirmed after every mutation.
**Verdict: clean.** F1–F6 all resolved. No new findings. One non-blocking residual noted at the end.

**FORK gate re-measured:** base diff is 11 files, all `apps/server/src/j5/a2a/**`. Zero upstream appends, so A6 still contributes nothing to the four-anchor inventory and cannot be the duplicate.

**Baseline:** 23 tests pass across 5 files; `tsgo --noEmit` on `apps/server` exits 0 with no diagnostics in `j5/`.

## Disposition-by-disposition

| ID | Round-1 finding | Resolution | Verified how |
| --- | --- | --- | --- |
| **F1** | reparent authenticated but never identified; `actor: 'human'` asserted | `reparent(caller, input)` takes an explicit `{kind:"environment", principal}` \| `{kind:"mcp", scope}` union; MCP refused, non-`browser-session-cookie` refused naming method + subject; success records `actor_session_id` / `actor_subject` / `auth_method` **measured from the principal**; migration CHECK forces those non-null and `auth_method = 'browser-session-cookie'` on reparent rows. The tautological `reparentFromMcp` stub is gone. | **mutation:** relaxed the method check to `=== "dpop-access-token"`; the reparent test failed. The guard is real and its test can fail. |
| **F2** | cascade `stop`/`archive` untested | `makePlacementCascadeService` now takes injected deps typed with the **real upstream signatures** (`ThreadManagementInterruptInput/Result`, `OrchestrationV2ThreadProjection`), and the live layer uses the same constructor. New test covers leaves-first ordering, per-thread command ids, the already-archived skip, and mid-cascade failure halting with earlier descendants left dispatched. | **mutation:** dropped `threadId` from the derived command id; both cascade tests failed. Live-wiring shape independently proven by `tsgo` exit 0 — the stubs cannot drift from the real API without breaking the layer. |
| **F3** | "ordinary creation" test created nothing; `unknown` and unrecorded indistinguishable | `COALESCE` removed; null provenance now surfaces as a distinct `{kind:"unrecorded"}` view case, documented in the contract. Test now performs a real creation for one participant and asserts `unknown`, while a second participant with no placement row asserts `unrecorded`. | **mutation:** mapped null provenance back to `unknown`; the test failed. |
| **F4** | cascade/fork consequence undocumented | Contract-level JSDoc on `PlacementCascadeInput` states the traversal follows mutable placement, that **a fork defaults beside its source so cascading the source does not reach it**, and the command-id derivation. | read at `PlacementCascadeService.ts:20-24` |
| **F5** | barrel omitted both services | `index.ts` exports both via explicit named exports rather than `export *` — which also avoids error-class name collisions. | read |
| **F6** | two cycle detectors, neither corrupt-graph branch tested | Both detectors kept, both branches now tested: a test corrupts the stored graph into an A↔B cycle directly in SQL and asserts `PlacementGraphCorruptError` from **both** the mutation path (`assertAcyclic`) and traversal (`listSubtree`). The non-null-assertion nit got the invariant comment. | read; covered by the passing suite |

My round-1 ask on F6 was "drop one or test the branch that stays" — testing both is a valid resolution, and the SQL-level corruption fixture is a better negative control than deletion would have been.

## Residual, non-blocking

The cascade harness builds its projection stub as a partial object cast `as OrchestrationV2ThreadProjection`, with `archivedAt` as a string where the real type is `DateTime | null`. Production only tests `!== null`, so behavior is right and the *signatures* — the part that guards against API drift — are genuinely upstream-typed. But the cast means a change in `archivedAt` semantics wouldn't be caught here. Not worth a round; worth knowing if that field ever changes upstream.

Also noted without action: `PlacementReparentedEvent.authMethod` accepts all three `ServerAuthSessionMethod` values while the DB CHECK permits only `browser-session-cookie`. The schema is deliberately wider than the constraint; the constraint is the enforcement point.

# Round 1 detail (historical)

## Actionable checklist (round 1)

1. **F1** — reparent's human-only gate authenticates but never checks identity, while the event records `actor: 'human'` as a constant.
2. **F2** — cascade `stop`/`archive` operations have zero test coverage; only the traversal is proven.
3. **F3** — the "ordinary creation → unknown provenance" test never performs a creation, and `list_participants` can't distinguish unrecorded from unknown.
4. **F4** (low) — cascade-vs-fork consequence isn't documented where the ticket requires.
5. **F5** (low) — `index.ts` barrel omits both new services.
6. **F6** (low) — two cycle detectors, neither corrupt-graph branch tested.

## What I verified, and how

Positives recorded so the next reader doesn't re-derive them.

**FORK gate: passes.** All ten changed files live under `apps/server/src/j5/a2a/**`; `git diff --stat 521c50aa9 d65acfdca` shows no protected file. The J5 migration lane is preserved — migration 002 registered in the J5 id space and J5 tracking table, never upstream's `Migrations.ts`. Pin untouched. A6 correctly made **no** edit to `McpHttpServer.ts`, `server.ts`, or FORK.md, so there is no duplicate registration.

**Provenance typing discriminates — proven, not read.** I mutated `placementProvenance.ts` to return `spawned-by` for the `"fork"` case; `placementProvenance.test.ts` failed on the `forked` assertion. Restored, tree clean. The test is genuinely discriminating: all three kinds in one test, delegated and fork identical except `relationshipToParent`, and the ordinary case deliberately passes a **non-null** `parentParticipantId` to prove the caller breadcrumb loses to root lineage. That is exactly the control the ruling needed.

**Cascade follows placement — proven.** I mutated `resolveCreationParent`'s `other_parent` case to prefer the spawner; the two-tree cascade test and the sibling test both failed. Restored, tree clean. The fixture is well built: `movedToSecond` is spawned-by tree A but placed in tree B and vice versa, so a provenance-following traversal cannot produce the asserted output.

**All three fork controls I asked for pre-handoff are present and correct** (`PlacementService.test.ts:152-225`): fork of a root source lands at root and explicitly *not* under the source; reparent-the-source-then-fork inherits the new placement parent; a later reparent of the source does not move the existing fork (snapshot, not alias).

**Cycle check** is a new J5 algorithm (`assertAcyclic`, `PlacementService.ts:492-524`) — walks to root from the requested parent, names the offending path in the error, and the test asserts no state changed on refusal. Correct, and correctly *not* borrowed from v2, which has none.

**Baseline:** 11 tests pass across the three touched files; `tsgo --noEmit` on `apps/server` is clean.

## F1 — MEDIUM — reparent authenticates the caller but never identifies it

- **reviewed SHA:** `d65acfdca` · **current SHA:** `d65acfdca` · **still applicable:** yes
- **required:** the human-only reparent must either verify the principal is human, or stop recording `actor: 'human'` as an unverified constant.
- **mechanism:** `PlacementService.ts:870-874` requires `EnvironmentAuthenticatedPrincipal`, then discards it — `Effect.andThen` never reads a field. The type is `EnvironmentSessionPrincipalShape` (`packages/contracts/src/environmentHttp.ts:342-354`), whose `method` may be `bearer-access-token` — documented in `packages/contracts/src/auth.ts:60-73` as "suitable for non-cookie or **non-browser clients**" — or `dpop-access-token` (relay). So the gate proves *an authenticated environment session*, not *a human*. The test principal carries `scopes: new Set()` (`PlacementService.test.ts:37-42`) and passes, so not even a scope is required. Meanwhile `reparentEffect` writes the literal `'human'` into `actor` (`PlacementService.ts:685`), and migration 002 CHECKs that reparent rows are `actor = 'human'` — the schema enforces the *claim*, nothing enforces the *fact*. In a ticket whose subject is truthful provenance, and against the register's measured-vs-asserted principle (P2), the one event a human authors is the one recorded on assertion.
- **the refusal that exists doesn't cover this:** `reparentFromMcp` (`:875-883`) is a constant `Effect.fail` typed `Effect<never, …>`. Its test (`:301-314`) cannot fail unless the function is deleted, and its "no new events" assertion is vacuous because the body never touches the database. Nothing calls it in this tree. It documents an intent; it does not enforce one. A future MCP handler that calls `reparent` with any environment principal in context is not stopped by anything here.
- **suggested fix (non-binding):** inspect the principal — refuse non-`browser-session-cookie` methods, or require a scope — and prove it with a test that feeds an agent-shaped principal and asserts `PlacementHumanRequiredError`. That test can fail, unlike the current one. If instead the group's position is "any authenticated environment session is human in v1," then record `actor` from the principal's `subject`/`method` rather than hard-coding it, and state the assumption in the contract doc.
- **owner:** builder · **status:** open

## F2 — MEDIUM — the cascade operations are untested; only the walk is proven

- **reviewed SHA:** `d65acfdca` · **current SHA:** `d65acfdca` · **still applicable:** yes
- **required:** `PlacementCascadeService.stop` / `.archive` need coverage, or the acceptance claim must be narrowed to traversal.
- **mechanism:** every cascade assertion goes through `runPlacementCascade` with a stub operation (`PlacementService.test.ts:369-383`, `operation: (p) => Effect.succeed(p.participantId)`). `PlacementCascadeService` — the layer, `stop`, `archive` — is never instantiated in any test in the tree. Untested as a result: the `threads.interruptThread` wiring and its outcome mapping, the `lifecycle.archive` wiring, the `already_archived` short-circuit (`PlacementCascadeService.ts:155-161`), the derived per-thread command id `${commandId}:${operation}:${threadId}` (`:109-113`), and the partial-failure behavior the error message promises ("descendants already processed remain settled"). The ticket's acceptance is "cascade follows placement in a scripted two-tree fixture" — the *follows placement* half is proven and discriminating; the *stop/archive* half is not exercised at all.
- **why it's worth a round:** the derived command id is the idempotency key for the upstream commands. If it collides or drifts, a re-run either double-dispatches or silently no-ops, and nothing currently notices.
- **suggested fix:** a fixture with stub `ThreadManagementService` / `ThreadLifecycleService` asserting per-thread calls in leaves-first order, the already-archived skip, and a mid-cascade failure leaving earlier descendants settled.
- **owner:** builder · **status:** open

## F3 — MEDIUM — the "ordinary creation" test performs no creation

- **reviewed SHA:** `d65acfdca` · **current SHA:** `d65acfdca` · **still applicable:** yes
- **required:** prove that an ordinary creation *records* unknown provenance, and make `list_participants` distinguish "recorded unknown" from "no placement row".
- **mechanism:** `PlacementService.test.ts:227-241` is named "reports ordinary or unobserved creation as explicit unknown provenance" but never calls `record()` / `recordCreation`. It joins a participant, reads `listParticipants`, and asserts the LEFT JOIN default `COALESCE(p.provenance_kind, 'unknown')` (`PlacementService.ts:730`). It would pass unchanged if creation-time provenance recording were entirely broken — it is not a control on creation, it is a control on the read default.
- **the substantive half:** because of that COALESCE, `list_participants` reports a participant with **no placement row** identically to one recorded as `unknown`. The ticket's stated purpose for this surface is that "callers and future UI read the same truth"; today the surface cannot tell "we know this was an ordinary create" from "we never recorded this one." The typed provenance union went to the trouble of distinguishing three kinds; the read model collapses a fourth state into one of them.
- **suggested fix:** either record placement at participant-join so every member has a row, or surface unrecorded distinctly (the view union already has a `not-applicable` precedent for the human node). Then rewrite the test to perform an ordinary creation and assert the stored provenance.
- **owner:** builder · **status:** open

## F4 — LOW — cascade/fork consequence isn't documented where the ticket asks

The ticket requires cascade semantics "documented in the command contracts". Today it is a JSDoc on `runPlacementCascade` (`PlacementCascadeService.ts:58-62`), which does say provenance is deliberately absent from traversal — good, but it stops short of the consequence the fork ruling created: **a fork is a sibling of its source, so cascading stop/archive on the source never reaches its forks.** That is the single most surprising behavior in this ticket and the one most likely to be reported as a bug later. It belongs in the contract-level doc, not only next to the traversal helper.

## F5 — LOW — the barrel omits both new services

`index.ts` exports `placementContracts.ts` and `placementProvenance.ts` but not `PlacementService.ts` or `PlacementCascadeService.ts`. Anything importing the J5 A2A barrel — A2's toolkit being the imminent case — cannot reach `ParticipantPlacementService` or `PlacementCascadeService` without a deep import. Trivial to fix; flagged because reachability is exactly the pending integration.

## F6 — LOW — two cycle detectors, neither corrupt-graph branch tested

`assertAcyclic` carries a visited set *and* a membership bound, both raising `PlacementGraphCorruptError`; `listSubtree` then implements a second, independent detector (`visiting`/`visited`/`path`, `PlacementService.ts:908-927`) raising the same error. Neither corrupt-graph branch has a test, and the state they defend against is the one `assertAcyclic` exists to prevent. In a 940-line service this is the kind of defensive machinery worth one pass of subtraction — keep the traversal guard that terminates the walk, drop the redundant one, or test the branch that stays. Related nit: `provenanceFromRow` (`:224-245`) relies on non-null assertions that are only safe because of the migration CHECKs; a comment tying the two together would stop a future reader from "fixing" the constraint.

## Untested integration boundary (not a core defect)

Per the Sitter's scoping: nothing in this tree calls `provenanceFromThreadLineage`, `reparentFromMcp`, or the `PlacementCascadeService` layer outside tests, because A2 owns the shared MCP bootstrap and is reviewing it independently at `b9131d394`. Consequences to carry forward rather than treat as A6 defects:

- The lineage→provenance derivation is unit-proven but unwired; the mapping from `lineage.parentThreadId` to a J5 `ParticipantId` is supplied by the caller and therefore untested end to end.
- No acceptance evidence here runs through the MCP tool surface; every control is at the service layer. That is the correct and honest level given the lane, and the Builder should say so plainly rather than let service-layer green read as tool-surface proof.
- F5 is the J5-side prerequisite for that wiring.

## Pre-merge gate — FORK append inventory (not a core defect)

Added after the Director tightened FORK.md: before either shared-toolkit PR merges, the upstream-append inventory must be explicit and anchored — no category-wide standing permission.

**A6's own position is clean.** At `d65acfdca` A6 uses no upstream seam and introduces no append, so it cannot be the duplicate. Its future use is a tool definition inside A2's toolkit file, which creates no new anchor. That is the check to re-run when A6 attaches its tools.

**Measured state of the lane** (`git diff 993407dd9 d65acfdca`, upstream pin to reviewed head). The A2A build carries a fourth upstream append beyond the relayed three (one MCP registration seam + two test appends):

| Anchor | Content | Landed |
| --- | --- | --- |
| `apps/server/src/persistence/Layers/Sqlite.ts:10` | `import { runJ5A2AMigrations } from "../../j5/a2a/Migrations.ts";` | A1 (`521c50aa9`, PR #4) |
| `apps/server/src/persistence/Layers/Sqlite.ts:42` | `yield* runJ5A2AMigrations();` | A1 (`521c50aa9`, PR #4) |

It is a protected-surface append (`apps/server` core persistence) and is neither the registration seam nor a test append. Its current authorization is FORK.md's migration-lane sentence — "retain only the small startup call that runs J5 migrations after upstream migrations" — which describes a permitted *kind* of edit with no file or line anchor. That is the category-wide standing permission the tightening removes, so this is the one existing case the new rule catches, and it is already merged.

**Scope ambiguity routed to the Spawner** (Sitter is carrying it; supersedes board decision #6 once ruled): does the finite inventory cover only new/unmerged A2/A6 appends, or the full A2A-build delta from pin — which adds the two anchors above? Either ruling is workable; the inventory just has to say which, because the pin-to-head diff shows 37 upstream-owned files modified, nearly all pre-A2A rebrand and toolchain work (e.g. `apps/server/src/http.ts:29,47-50`, desktop/mobile/web branding). An inventory that claims to list "the authorized upstream appends" without stating its scope reads as false to anyone who runs the diff.

Reviewer recommendation: state the scope in the inventory's first line ("A2A-build appends against pin `993407dd9`"), carry four anchored entries, and leave the rebrand delta outside as pre-existing baseline — that keeps the inventory reproducible with one command, which is the property the tightening is after.

## Notes for the next reviewer

- The provenance and cascade tests were confirmed capable of failing by deliberate mutation (fork→`spawned-by`; `other_parent`→provenance). Don't re-derive — but *do* re-run them if the resolution of F1/F3 touches `resolveCreationParent` or `listParticipants`.
- `assertAcyclic` walking from the *requested parent* rather than from the participant is correct, not a bug: the participant's own pointer is being replaced, so the walk must start where the new edge lands.
- `siblingOf` returning `null` for a source with no placement row is the "root if absent" rule, not a silent failure — though it shares the ambiguity described in F3.
