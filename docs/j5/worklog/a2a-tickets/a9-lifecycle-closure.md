---
title: "A9 — Lifecycle closure: participant retirement terminates obligations, loudly (R1/R11)"
kind: ticket
status: 1
---

# A9 — Lifecycle closure

**Governing artifacts:** design-review register R1 and participant-side R11 (../../product/design-review-2026-08-21.md). Staff against current `j5/main` head. **Hazard note (why this is blocking-tier): participant retirement already happens in practice and currently strands open obligations silently.**

## Goal

Retiring a participant terminates its open obligations as a loud, evented act — waiters are told, nothing dangles, and history stays readable.

## Scope

1. **Participant archive termination (R1):** archiving a participant transitions its open Exchanges to **Dropped** with platform-authored terminal notices delivered to the affected counterparties through the normal pipeline — both dispositions: receiver-retired (waiter told: dropped, carries do-not-retry/do-not-replace) and sender-retired (the reply-owing party told the asker is gone; its obligation ends). Notices are fact bundles per R4.
2. **Active-view hiding (R11, participant half):** `participant.left` removes the retired participant from active membership reads while its append-only ledger history remains readable forever. No extra participant archive column is needed because the real lifecycle writer already exercises this projection.
3. **Write authority note:** this is NEW machinery, deliberately not an A3 extension — silence notices inform and never change Exchange state; archive termination is a state-transitioning write authority. Same pattern family (lifecycle fact → platform-authored ledger rows → pipeline delivery), separate service.
4. **Committed thread bridge:** a bounded J5-owned reactor consumes committed `thread.archived` and `thread.deleted` events from a durable cursor and routes registered A2A homes through the same idempotent termination authority. Native threads without an A2A home are explicit no-ops. Restart, archive→delete, and replay must not duplicate terminal dispositions or notices.
5. **A3/A9 serialization rule:** A3 may derive a silence fact while an Exchange is open, but its ledger append must recheck `status = open` inside the same permit-protected transaction that commits the notice. If A9 has already committed Dropped, A3 emits nothing; if A3 commits first, both the silence fact and later Dropped fact remain true history. A3 remains informational and never transitions Exchange state.
6. **AR2 fact gathering only:** a read-only service reports a registered participant's open inbound and outbound Exchanges for the future human pre-archive dialog. Placement subtree data sits behind a provider and is structurally `unknown`, `none`, or `known`; the current provider returns `unknown` until the A6 component table is ratified. The service displays facts only and makes no archive/settle decision.

## Scope amendment — Squadron archive deferred

The settled archive-flow work ([product contract](../../product/features/archive-flow.md), [session ruling](../archive-flow-session-2026-08-29.md)) and Squadron SC4 ([feature definition](../../product/features/squadron.md)) supersede A9's original R2/Squadron half. All Squadron-archive-shaped work is deferred to SC4 polished-later: no operation, HTTP/MCP/server surface, warning/confirmation path, event, schema column, or projection dimension ships here. Migration `008_LifecycleClosure` contains no Squadron schema. Existing append-only ledgers already remain readable; a future SC4 implementation can compose the R1 participant termination machinery after its user contract ships.

Known migration cost: rebuilding `j5_a2a_exchange` activates A4's `ON DELETE CASCADE`, so 008 snapshots and restores every A4 inbox column opaquely inside the one migration transaction. Any future rebuild of this parent faces the same hazard; recurring snapshot code must become a separately reviewed migration-framework helper rather than another copy-paste.

AR2 surface sequencing: A4's sanctioned J5 HTTP routes layer now exists, but A9 supplies only the service-complete read boundary and defers route registration until the human archive-dialog surface is ratified. An MCP read tool was measured as technically possible and rejected because the consumer is the human pre-archive dialog, not an agent. Whether open Exchanges should affect upstream Settle remains an explicit future decision; this service only makes the facts demonstrable.

Future composition note: A2S `archive_agent` will call `ArchiveFactsService` for the AR2 preflight read and call `LifecycleService.archiveParticipant` directly for the idempotent R1 termination. It must not duplicate either engine or archive-and-hope that the asynchronous reactor catches up. A9 intentionally adds no A2S handler or tool stub.

## Out of scope

Squadron archive and AR1–AR4 warn/confirm behavior (SC4 polished-later), Memos-on-archive warning (R35 — ships with the Memos feature, not here), and Captain-invoked crew archive (R18–R22 — item-3 territory). A later upstream `thread.unarchived` event does not revive A2A participation, reopen Dropped exchanges, retract lifecycle notices, or recreate obligations. Re-entry remains undesigned and requires a separately ratified lifecycle policy.

## Dependencies

A2 and Registrar PR #10 are merged. A9 consumes Registrar's immutable `resolveThreadHome` history and complete-payload `participant.left` retirement. Fleet allocation is fixed: A4 `006_HumanNode`, then A6 `007_ParticipantPlacement`, then A9 `008_LifecycleClosure`. The final pre-PR rebase must verify that exact contiguous manifest; A9 must stop rather than self-adjust if it differs.

## Acceptance

Scripted scenarios: archive a participant owing a reply → waiter receives Dropped notice with do-not-retry facts, exchange terminal in ledger and projections; archive a participant who is owed a reply → counterparty notified, obligation ended; **archive an agent holding an open Exchange addressed to a PERSON (the person owes the reply) → the person's inbox row is removed/closed visibly and evented — never left dangling, never silently vanished (R1 sender-retired disposition on the inbox surface, per design-review authority's addition)**; committed deletion of a reply-owing participant yields the same single terminal disposition/notice; archive→delete and restart/replay never duplicate closure; deterministic A3-read→A9-drop→A3-append ordering emits no stale silence row, while A3-append→A9-drop preserves both rows; negative controls: same- and cross-Squadron healthy exchanges remain untouched, native no-home thread retirement is a no-op, no Squadron archive API/schema is introduced, and an A2A-retired participant rejects new sends with a state-naming error even after upstream unarchive; focused migration/runtime/domain suites green on the final post-A4/A6 rebase.

Final proof order is binding: first make the deterministic seed harness green on the exact stationary post-rebase head; only after independent stationary review, run the R1 acceptance through a real Codex Luna participant in isolated disposable state, capture the resulting lifecycle evidence, and shut that state down. The standing test grant removes per-run approval for this final proof, but it does not permit an early live run or bypass Director usage-limit gates.

The Luna run must use worktree-local `.t3/userdata`, never the live `~/.t3/userdata`; any realistic seed comes from a safe copy or `VACUUM INTO`, never a symlink. Capture the spawned server PID and tear down only that PID—no pattern kill or `pgrep`, because the worktree path is present in agent process arguments. Evidence is discriminating only when it captures the waiter's received lifecycle-notice text, the ledger's terminal Exchange state, and the persisted do-not-retry fact bundle; a clean run or absence of errors is not acceptance evidence.
