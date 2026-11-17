import { MessageId, ThreadId } from "@t3tools/contracts";
import {
  PlaybookError,
  type PlaybookStepDelivery,
  type PlaybookStepResponse,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
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
): PlaybookStepResponse => ({ ...response, delivery });

export const makePlaybookCrewRelay = Effect.gen(function* () {
  const store = yield* PlaybookStore;
  const threads = yield* ThreadManagementService;
  const locks = new Map<string, Semaphore.Semaphore>();
  const withRun = Effect.fn("PlaybookCrewRelay.withRun")(function* <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) {
    let lock = locks.get(key);
    if (lock === undefined) {
      lock = yield* Semaphore.make(1);
      locks.set(key, lock);
    }
    return yield* lock.withPermits(1)(effect);
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
    if (landing.targetThreadId === run.ownerThreadId)
      return result(yield* store.resolveLanding(runId, requestId, "captain"));
    if (landing.targetThreadId === null || landing.targetParticipantId === null)
      return result(landing, "the recorded holder is missing");
    const { step, ...playbook } = yield* store.snapshotStep(run, landing.stepId);
    if (step === null) return result(yield* store.resolveLanding(runId, requestId, "skipped"));
    const targetThreadId = ThreadId.make(landing.targetThreadId);
    const sent = yield* Effect.gen(function* () {
      const target = yield* getThreadRecordsIfPresent(threads, targetThreadId, []);
      if (target === null || target.thread.archivedAt !== null || target.thread.deletedAt !== null)
        return false;
      yield* threads.dispatch({
        type: "message.dispatch",
        createdBy: "system",
        creationSource: "server",
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
          ownerParticipantId: landing.assignedByParticipantId ?? run.assignedByParticipantId ?? "",
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
      if (delivery?.state === "pending")
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
    return run === null || landing === null ? null : deliveryOf(landing, run.ownerThreadId);
  });
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
  const start = (input: {
    readonly owner: ThreadId;
    readonly root: string;
    readonly name: string;
    readonly key: string;
    readonly assignee?: string;
  }) =>
    withRun(
      input.owner,
      Effect.gen(function* () {
        const response = yield* store.start(
          input.owner,
          input.root,
          input.name,
          input.key,
          input.assignee,
        );
        return yield* respond(response, input.key);
      }),
    );
  const mutate = Effect.fn("j5.playbooks.playbookCrewRelay.mutate")(function* (
    owner: ThreadId,
    input: PlaybookMutation,
  ) {
    const run = yield* store.runById(input.runId);
    if (run?.ownerThreadId !== owner) return yield* store.mutate(owner, input);
    return yield* withRun(
      run.runId,
      Effect.gen(function* () {
        if (input.operation !== "assign" && input.operation !== "cancel")
          yield* drainLocked(run.runId);
        const response = yield* store.mutate(owner, input);
        if (input.operation === "complete" || input.operation === "cancel")
          return withDelivery(response, null);
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
    return withDelivery(
      response,
      response.status === "active"
        ? yield* currentDelivery(response.runId, response.currentStepId)
        : null,
    );
  });
  return { start, mutate, current, deliver, drainRun, currentDelivery };
});

export class PlaybookCrewRelay extends Context.Service<
  PlaybookCrewRelay,
  Effect.Success<typeof makePlaybookCrewRelay>
>()("t3/j5/playbooks/PlaybookCrewRelay") {}
export const layer = Layer.effect(PlaybookCrewRelay, makePlaybookCrewRelay);
