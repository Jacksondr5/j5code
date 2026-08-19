---
title: "A3 review — independent verdict, rounds 1–3"
kind: review
---

# A3 silence detector — Reviewer verdict

Three review rounds. Round 1 blocked at `78deeb01e` with six findings; round 2 at `fd3206830` verified all six fixed and raised one new medium; round 3 at `55e4cdf50` closed it.

**Final state: APPROVED to open the PR at `55e4cdf50d167854b0ae9a6d9e9b7cc2ab2aa31d`. Zero open findings** — #35–#41 all `fixed`. Ledger findings live in `prg`, which is their sole home; pre-PR findings are ledger findings, not thread findings.

## Round 3 — `55e4cdf50d167854b0ae9a6d9e9b7cc2ab2aa31d`

Clean tree, local == remote, three commits off `fdd04688c`, still 17 files all under `apps/server/src/j5/a2a/`. Suite: 10 files / 51 tests passed.

**#41 → fixed.** `reconcileOpenExchangesRaw` no longer appears anywhere in the retry path (verified by diff), hoisted into a one-time `prepareLifecycleStream` carrying its own backoff; retries are `readCursor` + `streamStoredEventsFrom` only. Backoff is capped exponential 250ms→30s, reset on any successfully processed event. `Effect.die("lifecycle subscription ended")` also turns a normally-completing stream into a retry rather than a silently dead daemon.

Negative control: replacing the doubling with a fixed 250ms fails the new TestClock test with `expected 3 to equal 2`. Tree restored, head unchanged, suite green.

Both round-2 lows were taken — `subjectId` removed from `appendNotice`, and an explicit `"processed" as const` with a comment naming the SQL invariant replaces the always-true helper.

### Two low observations, deliberately not opened as rows

- `runLifecycleStream` still carries `existing ?? initializeCursor()`. Unreachable after `prepare` succeeds, but it would reintroduce #41 if ever reached — dead code holding the old bug. Having `prepare` return the checkpoint would delete the branch.
- The backoff test proves timing but not the hoist: it seeds no exchanges, so reconciliation is a no-op either way and the test would pass with the reconcile left in the retry path. The hoist is verified by construction from the diff.

Neither needs action; rows for unactioned findings would only block `group done` later.

## Round 2 — `fd320683081b337be829f8b0cb16619ab63bf8fe`

Measured: clean tree, local == remote, two commits off `fdd04688c`, all 17 files still under `apps/server/src/j5/a2a/`. Full `j5/a2a` suite: 10 files / 50 tests passed.

### The fixes were verified by negative control, not by reading

Both high-severity regressions were injected back into `SilenceDetector.ts` at this head and the suite re-run:

| Injected revert | Test outcome |
| --- | --- |
| `processingState(…, run.completedAt)` → `run.startedAt` | mid-turn test fails: `expected 'never-processed' to equal 'processed'` |
| `afterSequence: checkpoint` → `afterSequence: 0` | daemon test fails: `expected +0 to equal 75` |

Tree restored, head unchanged, suite green. Both guards discriminate — they are not tests that merely pass.

### Disposition

| id | was | now | evidence |
| --- | --- | --- | --- |
| #35 | high | fixed | `processingState` compares delivery to `run.completedAt`, so a mid-turn steer is `processed`; genuine `never-processed` moved to `inspectOpenDelivery` via `runCoversDelivery`, with nullable `runId`. A run started *by* the delivery (`userMessageId` match) or still in flight counts as covering, so `run === undefined` really means "no turn since delivery". |
| #36 | high | fixed | Migration 004 adds a singleton durable cursor. First init reads the `orchestration_v2_events` high-water mark — table name confirmed genuine at `persistence/Migrations/041_OrchestrationV2.ts:9` — reconciles open delivered exchanges, then tails from the cursor. Replay tail bounded to 127 events; cursor writes monotonic; reconcile-before-write means a failed reconcile re-initializes. |
| #37 | med | fixed | Carrier sender is now `SILENCE_DETECTOR_PARTICIPANT_ID` (`platform:silence-detector`). `silence.notice.sender` stays null, transport still `createdBy: "system"`. The platform id has no membership row, so it correctly never appears in `list_participants`. |
| #38 | med | fixed | Daemon test drives the real `streamStoredEventsFrom` boundary through the production layer against real SQLite, forces the first stream to die, proves retry and durable cursor advance. Silent death replaced by logged retry; delivery-stream failures warn and reconcile. |
| #39 | med | fixed | `dependencyNotice` orders candidates `created_at DESC`; test asserts the newer of two peer exchanges structurally. |
| #40 | med | fixed | Dedupe test uses terminal sequences 100 then 101, so the `commandId` receipt cannot mask the `prior`-delivery guard. |

### New — #41 (medium, open)

`runLifecycleDaemon` is `Effect.forever(runLifecycleStream.pipe(catchCause(warn + sleep 250ms)))`, and `runLifecycleStream` opens with `reconcileOpenExchangesRaw()` (`SilenceDetector.ts:610-643`). Every retry re-runs full reconciliation — a three-way join plus a correlated `MAX(seq)` subquery over `j5_a2a_comm_event` — on a fixed backoff that never grows.

Not hypothetical: `Orchestrator.ts:7280-7285` is a "live runtime is not configured" stub whose `streamStoredEventsFrom` returns `Stream.fail` immediately. On a host where the J5 layer is composed without the v2 live runtime, this is ~4 reconciliation scans and ~4 warning logs per second, indefinitely. Same failure class as #36 — a dependency problem becoming continuous database work — triggered by failure rather than boot.

Remedies offered: exponential backoff, and/or hoist the reconcile to run on successful resubscription rather than every attempt. A refutation showing the not-configured stub cannot reach the J5 composition path would also close it.

## Scope and fork discipline — clean in both rounds

FORK.md exception inventory still exactly four; no upstream-owned file touched; detector composes via `makeJ5A2ARuntimeLayer`. No registrar/A6 lane files, no production membership writer, no pin advance, zero `epic` residue in new code.

## What is being certified

A3's derivation, wiring, and scope **only**. Final end-to-end acceptance stays held pending the registrar/A6 real wrapper-path re-proof (`apps/server/src/j5/a2a/README.md:9`, wording re-checked intact at `fd3206830`). A green A3 must not be read as green end-to-end.
