import { MessageId, ThreadId, type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import {
  PlaybookError,
  type PlaybookStepDelivery,
  type PlaybookStepResponse,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService } from "../a2a/AgentCrewInstanceService.ts";
import { participantIdForThread } from "../a2a/HomeRegistrar.ts";
import { stopThread, agentStopReason } from "../a2a/stopThread.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../../orchestration-v2/DispatchModeLimit.ts";
import { lifecycleCommandId, lifecycleId } from "../a2a/spawnIds.ts";
import { getThreadRecordsIfPresent } from "../a2a/threadProjectionReads.ts";
import { crewStepNoticeText } from "./crewStepNotice.ts";
import {
  PlaybookStore,
  playbookError,
  type PlaybookLanding,
  type PlaybookMutation,
} from "./PlaybookStore.ts";

const PLAYBOOK_STEP_SESSION = "j5-playbook-step";
const isPlaybookError = Schema.is(PlaybookError);
const jsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const operationFailed = (error: unknown) =>
  isPlaybookError(error)
    ? error
    : playbookError("operation_failed", error instanceof Error ? error.message : String(error));
const stepCommandId = (runId: string, requestId: string) =>
  lifecycleCommandId({
    providerSessionId: PLAYBOOK_STEP_SESSION,
    requestKey: `${runId}:${requestId}`,
    operation: "playbook-step",
  });
const stepMessageId = (runId: string, requestId: string) =>
  MessageId.make(
    lifecycleId({
      providerSessionId: PLAYBOOK_STEP_SESSION,
      requestKey: `${runId}:${requestId}`,
      kind: "message",
      operation: "playbook-step",
    }),
  );

const deliveryOf = (
  landing: PlaybookLanding,
  ownerThreadId: string,
): PlaybookStepDelivery | null => {
  if (landing.outcome === "skipped") return null;
  const own = landing.targetThreadId === ownerThreadId;
  return {
    state: own ? "captain" : landing.outcome === "delivered" ? "delivered" : "pending",
    seat: landing.targetSeat,
    threadId: landing.targetThreadId,
    participantId: landing.targetParticipantId,
  };
};
const withDelivery = (
  response: PlaybookStepResponse,
  delivery: PlaybookStepDelivery | null,
): PlaybookStepResponse => ({
  ...response,
  ...(delivery?.state === "blocked" ? { currentStep: null } : {}),
  delivery,
});
const blockedDelivery = (reason: string): PlaybookStepDelivery => ({
  state: "blocked",
  seat: null,
  threadId: null,
  reason,
});

export const makePlaybookCrewRelay = Effect.gen(function* () {
  const store = yield* PlaybookStore;
  const threads = yield* ThreadManagementService;
  const crews = yield* AgentCrewInstanceService;
  const locks = yield* KeyedLock.make<string>();
  const withRun = locks.withLock;

  const finishCancellation = Effect.fn("PlaybookCrewRelay.finishCancellation")(function* (
    runId: string,
    immediate = false,
  ) {
    const run = yield* store.runById(runId);
    if (run === null || run.status !== "cancelled" || !(yield* store.claimHolderStop(runId)))
      return;
    const outcome = yield* Effect.gen(function* () {
      if (run.holderThreadId === null) return { status: "no_holder" as const, reason: null };
      if (run.holderThreadId === run.ownerThreadId)
        return { status: "owner_held" as const, reason: null };
      const target = yield* getThreadRecordsIfPresent(threads, run.holderThreadId, []);
      if (target === null || target.thread.deletedAt !== null)
        return { status: "failed" as const, reason: "The holder thread is unavailable." };
      const membership = yield* crews.findMembership(participantIdForThread(run.holderThreadId));
      const crew = membership === null ? null : yield* crews.read(membership.crewInstanceId);
      const captain = crew?.captainParticipantId === participantIdForThread(run.ownerThreadId);
      const owner = captain
        ? null
        : yield* getThreadRecordsIfPresent(threads, run.ownerThreadId, []);
      if (!captain && owner === null)
        return { status: "failed" as const, reason: "The owner modes cannot be resolved." };
      const limit =
        owner === null
          ? undefined
          : {
              runtimeMode: owner.thread.runtimeMode,
              interactionMode: owner.thread.interactionMode,
            };
      if (limit !== undefined && exceededDispatchModeLimit(limit, target.thread) !== undefined)
        return {
          status: "failed" as const,
          reason: "The holder runs above the owner's runtime or interaction mode.",
        };
      const command = {
        commandId: lifecycleCommandId({
          providerSessionId: "j5-playbook-cancel",
          requestKey: runId,
          operation: "stop-holder",
        }),
        threadId: run.holderThreadId,
        reason: agentStopReason("Playbook cancelled"),
      };
      // An explicit cancel stops the holder. Lifecycle events and retries may
      // arrive after it has taken on unrelated work, including delegated tasks.
      const stopped = immediate
        ? yield* stopThread(threads, command, limit)
        : yield* Effect.gen(function* () {
            const landing = yield* store.latestLanding(runId, run.currentStepId);
            if (landing?.targetThreadId !== command.threadId) return null;
            const notice = stepMessageId(runId, landing.requestId);
            const { runs } = yield* threads.getThreadRecords(command.threadId, ["runs"], {
              runStatuses: ["preparing", "starting", "running"],
            });
            const turn = runs.find((entry) => entry.userMessageId === notice);
            if (!turn) return null;
            return yield* threads
              .dispatch({
                ...command,
                type: "run.interrupt",
                runId: turn.id,
              })
              .pipe(Effect.provideService(DispatchModeLimit, limit));
          });
      if (stopped === null) return { status: "already_idle" as const, reason: null };
      const interrupted = stopped.storedEvents.some(
        ({ event }) =>
          (event.type === "run.updated" && event.payload.status === "interrupted") ||
          (event.type === "turn-item.updated" &&
            event.payload.type === "run_interrupt_request" &&
            event.payload.providerTurnId !== null),
      );
      return {
        status: interrupted ? ("stop_requested" as const) : ("already_idle" as const),
        reason: null,
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Playbook holder Stop failed", { runId, cause }).pipe(
          Effect.as({
            status: "failed" as const,
            reason: "The holder Stop command or delegated-task stop failed.",
          }),
        ),
      ),
    );
    yield* store.recordHolderStop(runId, outcome);
  });
  const reconcileOwners = Effect.fn("PlaybookCrewRelay.reconcileOwners")(function* () {
    for (const run of yield* store.unreconciledCancellations())
      yield* withRun(run.runId, finishCancellation(run.runId));
  });
  const handleOwnerEvent = Effect.fn("PlaybookCrewRelay.handleOwnerEvent")(function* (
    stored: OrchestrationV2StoredEvent,
  ) {
    const event = stored.event;
    if (event.type !== "thread.archived" && event.type !== "thread.deleted") return;
    const reason = event.type === "thread.archived" ? "owner_archived" : "owner_deleted";
    for (const { run_id } of yield* store.ownerLifecycleRuns(event.threadId, stored.sequence)) {
      yield* withRun(
        run_id,
        Effect.gen(function* () {
          yield* store.cancelOwner(event.threadId, reason, run_id);
          yield* finishCancellation(run_id);
        }),
      );
    }
  });

  const handOff = Effect.fn("PlaybookCrewRelay.handOff")(function* (
    runId: string,
    requestId: string,
  ) {
    const landing = yield* store.landing(runId, requestId);
    const run = yield* store.runById(runId);
    if (landing === null || run === null) return { delivery: null, reason: null };
    const result = (record: PlaybookLanding, reason: string | null = null) => ({
      delivery: deliveryOf(record, run.ownerThreadId),
      reason,
    });
    if (landing.resolvedAt !== null) return result(landing);
    if (run.status !== "active")
      return result(yield* store.resolveLanding(runId, requestId, "skipped"));
    if (
      landing.targetThreadId === null ||
      landing.targetParticipantId === null ||
      landing.assignedByParticipantId === null
    )
      return {
        delivery: {
          state: "pending" as const,
          seat: landing.targetSeat,
          threadId: landing.targetThreadId,
          participantId: landing.targetParticipantId,
        },
        reason:
          "the recorded holder or assigning owner identity cannot be resolved; use j5_playbook_assign to take back or reassign this step",
      };
    const { step, ...playbook } = yield* store.snapshotStep(run, landing.stepId);
    if (step === null) return result(yield* store.resolveLanding(runId, requestId, "skipped"));
    const targetThreadId = ThreadId.make(landing.targetThreadId);
    // Existing landings can predate persona enforcement in the run transaction.
    if (run.requiredPersonas === null) {
      const checked = yield* Effect.result(store.assertRequiredHolder(step, targetThreadId, true));
      if (checked._tag === "Failure") {
        const reason = checked.failure.message;
        return { delivery: blockedDelivery(reason), reason };
      }
    }
    if (targetThreadId === run.ownerThreadId)
      return result(yield* store.resolveLanding(runId, requestId, "captain"));
    const ownerParticipantId = landing.assignedByParticipantId;
    const sent = yield* Effect.gen(function* () {
      const target = yield* getThreadRecordsIfPresent(threads, targetThreadId, []);
      if (target === null || target.thread.archivedAt !== null || target.thread.deletedAt !== null)
        return false;
      yield* threads.dispatch({
        type: "message.dispatch",
        createdBy: "system",
        creationSource: "server",
        playbookOrigin: landing.playbookOrigin,
        commandId: stepCommandId(runId, requestId),
        threadId: targetThreadId,
        messageId: stepMessageId(runId, requestId),
        text: crewStepNoticeText({
          playbookName: playbook.name,
          playbookTitle: playbook.title,
          stepId: step.id,
          stepTitle: step.title,
          position: playbook.position,
          total: playbook.total,
          ownerParticipantId,
          prompt: step.prompt,
        }),
        attachments: [],
        modelSelection: target.thread.modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      return true;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("J5 playbook step hand-off remains pending", {
          runId,
          requestId,
          error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!sent) return result(landing, "the holder's thread could not accept the notice");
    const resolved = yield* store.resolveLanding(runId, requestId, "delivered").pipe(Effect.option);
    return resolved._tag === "Some"
      ? result(resolved.value)
      : result(landing, "the hand-off could not be recorded");
  }, Effect.mapError(operationFailed));

  const drainLocked = Effect.fn("PlaybookCrewRelay.drainLocked")(function* (runId: string) {
    for (const landing of yield* store.pendingLandings(runId)) {
      const { delivery, reason } = yield* handOff(runId, landing.requestId);
      if (delivery?.state === "pending" || delivery?.state === "blocked")
        return yield* playbookError(
          "delivery_pending",
          `The hand-off of step ${landing.stepId} to ${delivery.participantId ?? "its holder"} is pending: ${reason ?? "retry it"}. Use j5_playbook_assign to take back or reassign a stuck step.`,
        );
    }
  });
  const currentDelivery = Effect.fn("PlaybookCrewRelay.currentDelivery")(function* (
    runId: string,
    currentStepId: string,
  ) {
    const run = yield* store.runById(runId);
    const landing = yield* store.latestLanding(runId, currentStepId);
    if (run === null) return null;
    if (run.personaBlockReason !== null) return blockedDelivery(run.personaBlockReason);
    if (run.requiredPersonas === null) {
      const step = run.definition?.steps.find(({ id }) => id === currentStepId);
      const checked = yield* Effect.result(
        store.assertRequiredHolder(step, run.holderThreadId, landing?.resolvedAt === null),
      );
      if (checked._tag === "Failure") return blockedDelivery(checked.failure.message);
    }
    if (landing !== null) {
      const delivery = deliveryOf(landing, run.ownerThreadId);
      const target =
        run.holderThreadId === null
          ? null
          : yield* getThreadRecordsIfPresent(threads, run.holderThreadId, []);
      return delivery === null
        ? null
        : { ...delivery, ...(target?.thread.archivedAt != null ? { holderArchived: true } : {}) };
    }
    // Single-thread runs created before runtime staffing recorded no landing.
    return run.holderThreadId === run.ownerThreadId && run.holderParticipantId !== null
      ? {
          state: "captain" as const,
          seat: null,
          threadId: run.ownerThreadId,
          participantId: run.holderParticipantId,
        }
      : null;
  }, Effect.mapError(operationFailed));
  const respond = Effect.fn("PlaybookCrewRelay.respond")(function* (
    response: PlaybookStepResponse,
    requestId: string,
  ) {
    yield* handOff(response.runId, requestId);
    return withDelivery(
      response,
      response.status === "active"
        ? yield* currentDelivery(response.runId, response.currentStepId)
        : null,
    );
  });
  const start = Effect.fn("PlaybookCrewRelay.start")(function* (input: {
    readonly owner: ThreadId;
    readonly root: string;
    readonly name: string;
    readonly key: string;
    readonly assignee?: string;
  }) {
    const response = yield* store.start(
      input.owner,
      input.root,
      input.name,
      input.key,
      input.assignee,
    );
    return yield* withRun(
      response.runId,
      Effect.gen(function* () {
        // A mutation may acquire the run between insertion and this lock.
        const current = yield* store.current(input.owner, response.runId);
        return yield* respond({ ...current, replayed: response.replayed }, input.key);
      }),
    );
  });
  const mutate = Effect.fn("j5.playbooks.playbookCrewRelay.mutate")(function* (
    owner: ThreadId,
    input: PlaybookMutation,
  ) {
    const run = yield* store.runById(input.runId);
    if (run?.ownerThreadId !== owner) return yield* store.mutate(owner, input);
    return yield* withRun(
      run.runId,
      Effect.gen(function* () {
        const staffingRetry =
          input.operation === "revise" && input.retryStaffingStepId !== undefined;
        if (input.operation !== "assign" && input.operation !== "cancel" && !staffingRetry)
          yield* drainLocked(run.runId);
        const response = yield* store.mutate(owner, input);
        if (input.operation === "cancel") {
          yield* finishCancellation(
            run.runId,
            !response.replayed && response.cancelReason === "agent_cancelled",
          );
          return withDelivery(
            { ...(yield* store.current(owner, run.runId)), replayed: response.replayed },
            null,
          );
        }
        if (input.operation === "complete") return withDelivery(response, null);
        return yield* respond(response, input.client_request_id);
      }),
    );
  });
  const deliver = Effect.fn("j5.playbooks.playbookCrewRelay.deliver")(function* (
    runId: string,
    requestId: string,
  ) {
    return yield* withRun(
      runId,
      handOff(runId, requestId).pipe(Effect.map(({ delivery }) => delivery)),
    );
  });
  const drainRun = Effect.fn("j5.playbooks.playbookCrewRelay.drainRun")(function* (runId: string) {
    yield* withRun(runId, drainLocked(runId));
  });
  const current = Effect.fn("j5.playbooks.playbookCrewRelay.current")(function* (
    owner: ThreadId,
    runId?: string,
  ) {
    const response = yield* store.current(owner, runId);
    if (response.status !== "active") return withDelivery(response, null);
    const delivery = yield* currentDelivery(response.runId, response.currentStepId);
    if (
      delivery?.state !== "blocked" &&
      (response.holderParticipantId == null || response.assignedByParticipantId == null)
    )
      return yield* playbookError(
        "holder_unavailable",
        `The run's recorded holder or assigning owner identity cannot be resolved. Use j5_playbook_assign with runId=${jsonString(response.runId)} and expectedStepId=${jsonString(response.currentStepId)} to take back or reassign this step, or j5_playbook_cancel with that runId to end the run.`,
      );
    return withDelivery(response, delivery);
  });
  return {
    start,
    mutate,
    current,
    deliver,
    drainRun,
    currentDelivery,
    reconcileOwners,
    handleOwnerEvent,
  };
});

export class PlaybookCrewRelay extends Context.Service<
  PlaybookCrewRelay,
  Effect.Success<typeof makePlaybookCrewRelay>
>()("t3/j5/playbooks/PlaybookCrewRelay") {}
export const layer = Layer.effect(PlaybookCrewRelay, makePlaybookCrewRelay);
