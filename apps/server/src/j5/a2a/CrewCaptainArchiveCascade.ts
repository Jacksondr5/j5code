import type {
  OrchestrationV2Command,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { ArchiveCrewService } from "./ArchiveCrewService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";
import { crewSeatRequestKey, lifecycleCommandId } from "./spawnIds.ts";

const CASCADE_SESSION = "j5-captain-archive-cascade";

export interface CrewCaptainArchiveCascadeShape {
  /**
   * When a Captain's lifecycle event commits, carry its Crews with it: archive or delete retires
   * its live Crews as units, unarchive brings back the Crews its archive retired, and settle or
   * unsettle does the same to every seat of its live Crews. Returns the ids of the Crews it acted
   * on, or null when the event was not a Captain's.
   */
  readonly handleStoredEvent: (
    stored: OrchestrationV2StoredEvent,
  ) => Effect.Effect<ReadonlyArray<string> | null>;
  /**
   * The boot sweep, for events the stream missed while the server was down or a cascade that
   * exhausted its attempts: retire live Crews whose Captain is archived or gone, bring back Crews
   * that retired with a Captain that is live again, and settle the seats of a settled Captain.
   * Unsettle is event-only, since a settled seat under an unsettled Captain does not say which
   * came first. Returns the ids of the Crews it acted on.
   */
  readonly reconcile: Effect.Effect<ReadonlyArray<string>>;
}

export class CrewCaptainArchiveCascade extends Context.Service<
  CrewCaptainArchiveCascade,
  CrewCaptainArchiveCascadeShape
>()("t3/j5/a2a/CrewCaptainArchiveCascade") {}

/**
 * A Crew never outlives its Captain (Crews AC17): whatever happens to the Captain happens to its
 * Crews. A person's archive, settle, or unarchive cannot be refused or amended after the fact,
 * because upstream's command has already committed by the time J5 sees it, from the web sidebar,
 * a mobile swipe, or any future door. So the one place that sees every lifecycle event carries the
 * Crews along: an archive retires them as units through the same service the Captain and the
 * Fleet page use, with the person's act as the confirmation, and records that they retired with
 * the Captain so its unarchive brings them back; settle and unsettle are sent to each seat.
 * Command ids derive from the Captain, the Crew, the seat, and the event, so a replayed event
 * converges on the same commands and an already retired Crew replays as already archived.
 */
export const layer = Layer.effect(
  CrewCaptainArchiveCascade,
  Effect.gen(function* () {
    const crews = yield* AgentCrewInstanceService;
    const archives = yield* ArchiveCrewService;
    const threads = yield* ThreadManagementService;

    const retire = Effect.fn("j5.a2a.captainArchiveCascade.retire")(function* (
      captainThreadId: ThreadId,
      instance: AgentCrewInstance,
    ) {
      const requestKey = `${captainThreadId}:${instance.id}`;
      const archivedAt = DateTime.formatIso(yield* DateTime.now);
      const outcome = yield* archives.archive({
        providerSessionId: CASCADE_SESSION,
        callerParticipantId: null,
        squadronId: instance.squadronId,
        crewInstanceId: instance.id,
        clientRequestKey: requestKey,
        confirmationSatisfied: true,
        archivedAt,
        withCaptain: true,
        commandIds: (seatName) => ({
          interruptCommandId: lifecycleCommandId({
            providerSessionId: CASCADE_SESSION,
            requestKey: crewSeatRequestKey(requestKey, seatName),
            operation: "archive-crew-interrupt",
          }),
          archiveCommandId: lifecycleCommandId({
            providerSessionId: CASCADE_SESSION,
            requestKey: crewSeatRequestKey(requestKey, seatName),
            operation: "archive-crew-thread",
          }),
        }),
      });
      yield* Effect.logInfo("J5 Captain archived; its Crew retired as a unit", {
        captainThreadId,
        crewInstanceId: instance.id,
        status: outcome.status,
      });
    });

    // Retry transient failures in this session with the same command identities. Keep the
    // bound small so a broken Crew cannot prevent other Captains' events from being handled.
    const retireWithRetry = Effect.fn("j5.a2a.captainArchiveCascade.retireWithRetry")(function* (
      captainThreadId: ThreadId,
      instance: AgentCrewInstance,
    ) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const done = yield* retire(captainThreadId, instance).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 Captain archive attempt failed", {
              captainThreadId,
              crewInstanceId: instance.id,
              attempt,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (done) return true;
      }
      return false;
    });

    /** A thread's projection, or null when it cannot be read (never created, or a store fault). */
    const readThread = (threadId: ThreadId) =>
      threads.getThreadProjection(threadId).pipe(
        Effect.map((projection): OrchestrationV2ThreadProjection | null => projection),
        Effect.catchCause(() => Effect.succeed(null)),
      );

    const seatCommandId = (
      captainThreadId: ThreadId,
      instance: AgentCrewInstance,
      seatName: string,
      operation: string,
      occurrence: string,
    ) =>
      lifecycleCommandId({
        providerSessionId: CASCADE_SESSION,
        requestKey: crewSeatRequestKey(`${captainThreadId}:${instance.id}:${occurrence}`, seatName),
        operation,
      });

    /**
     * Settle or unsettle every seat of one live Crew that is not already there. Unsettle only
     * reaches seats that are settled, so a seat that never settled keeps upstream's automatic
     * settlement. A seat with no thread, or an archived one, is left alone.
     */
    const moveSeats = Effect.fn("j5.a2a.captainArchiveCascade.moveSeats")(function* (
      captainThreadId: ThreadId,
      instance: AgentCrewInstance,
      to: "settle" | "unsettle",
      occurrence: string,
    ) {
      let moved = false;
      for (const member of instance.members) {
        const seat = yield* readThread(member.threadId);
        if (seat === null || seat.thread.archivedAt !== null) continue;
        const settled = seat.thread.settledOverride === "settled";
        if (to === "settle" ? settled : !settled) continue;
        const commandId = seatCommandId(
          captainThreadId,
          instance,
          member.seatName,
          `captain-${to}`,
          occurrence,
        );
        const command: OrchestrationV2Command =
          to === "settle"
            ? { type: "thread.settle", commandId, threadId: member.threadId }
            : { type: "thread.unsettle", commandId, threadId: member.threadId, reason: "user" };
        yield* threads.dispatch(command);
        moved = true;
      }
      if (moved)
        yield* Effect.logInfo(`J5 Captain ${to}d; its Crew's seats followed`, {
          captainThreadId,
          crewInstanceId: instance.id,
        });
    });

    /**
     * Bring back a Crew that retired with its Captain: every archived seat thread is unarchived
     * (the lifecycle reactor restores each seat's agent from that event), then the Crew is live
     * again. The Crew's stamp is cleared last, so a restore cut short is finished by the sweep.
     */
    const restore = Effect.fn("j5.a2a.captainArchiveCascade.restore")(function* (
      captainThreadId: ThreadId,
      instance: AgentCrewInstance,
      occurrence: string,
    ) {
      yield* crews.serialize(
        instance.id,
        Effect.gen(function* () {
          for (const member of instance.members) {
            const seat = yield* readThread(member.threadId);
            if (seat === null || seat.thread.archivedAt === null) continue;
            yield* threads.dispatch({
              type: "thread.unarchive",
              commandId: seatCommandId(
                captainThreadId,
                instance,
                member.seatName,
                "captain-unarchive",
                occurrence,
              ),
              threadId: member.threadId,
            });
          }
          yield* crews.restoreWithCaptain(instance.id);
        }),
      );
      yield* Effect.logInfo("J5 Captain unarchived; its Crew came back with it", {
        captainThreadId,
        crewInstanceId: instance.id,
      });
    });

    /** One Crew step with the same bounded in-session retry as a retirement. */
    const attempt = Effect.fn("j5.a2a.captainArchiveCascade.attempt")(function* <E>(
      captainThreadId: ThreadId,
      instance: AgentCrewInstance,
      step: Effect.Effect<void, E>,
    ) {
      for (let tries = 1; tries <= 3; tries++) {
        const done = yield* step.pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 Captain lifecycle cascade attempt failed", {
              captainThreadId,
              crewInstanceId: instance.id,
              attempt: tries,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (done) return true;
      }
      return false;
    });

    const commandedBy = Effect.fn("j5.a2a.captainArchiveCascade.commandedBy")(function* (
      threadId: ThreadId,
    ) {
      // Placement and membership rows may already be gone for a deleted thread; the Crew
      // record names its Captain's thread directly, so the lookup needs no home.
      const involving = yield* crews.listInvolving({
        threadIds: [threadId],
        participantIds: [participantIdForThread(threadId)],
      });
      return involving.filter((instance) => instance.captainThreadId === threadId);
    });

    const handleStoredEvent: CrewCaptainArchiveCascadeShape["handleStoredEvent"] = (stored) =>
      Effect.gen(function* () {
        const event = stored.event;
        const threadId = event.threadId;
        const occurrence = String(event.id);
        const acted: Array<string> = [];
        switch (event.type) {
          case "thread.archived":
          case "thread.deleted": {
            const live = (yield* commandedBy(threadId)).filter(
              (instance) => instance.archivedAt === null,
            );
            if (live.length === 0) return null;
            for (const instance of live)
              if (yield* retireWithRetry(threadId, instance)) acted.push(instance.id);
            return acted;
          }
          case "thread.unarchived": {
            const retired = yield* crews.listRetiredWithCaptain(threadId);
            if (retired.length === 0) return null;
            for (const instance of retired)
              if (yield* attempt(threadId, instance, restore(threadId, instance, occurrence)))
                acted.push(instance.id);
            return acted;
          }
          case "thread.settled":
          case "thread.unsettled": {
            const live = (yield* commandedBy(threadId)).filter(
              (instance) => instance.archivedAt === null,
            );
            if (live.length === 0) return null;
            const to = event.type === "thread.settled" ? "settle" : "unsettle";
            for (const instance of live)
              if (yield* attempt(threadId, instance, moveSeats(threadId, instance, to, occurrence)))
                acted.push(instance.id);
            return acted;
          }
          default:
            return null;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 Captain lifecycle cascade skipped", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );

    /**
     * What the Captain's thread says now: gone (archived or deleted), settled, or live and
     * unsettled. A deleted thread keeps its projection with `deletedAt` set, so both read as
     * facts; a projection that cannot be read is the store's problem, and the sweep leaves that
     * Captain's Crews alone this pass.
     */
    const captainState = Effect.fn("j5.a2a.captainArchiveCascade.captainState")(function* (
      captainThreadId: ThreadId,
    ) {
      const read = yield* Effect.result(threads.getThreadProjection(captainThreadId));
      if (Result.isFailure(read)) {
        yield* Effect.logWarning("J5 Captain lifecycle sweep could not read a Captain thread", {
          captainThreadId,
          cause: read.failure,
        });
        return null;
      }
      const thread = read.success.thread;
      if (thread.archivedAt !== null || thread.deletedAt !== null) return "gone" as const;
      return thread.settledOverride === "settled"
        ? {
            state: "settled" as const,
            settledAt: thread.settledAt === null ? "" : DateTime.formatIso(thread.settledAt),
          }
        : ("live" as const);
    });

    const reconcile: CrewCaptainArchiveCascadeShape["reconcile"] = Effect.gen(function* () {
      const acted: Array<string> = [];
      // A defect while reading one Captain skips that Crew, not the sweep; one Crew's failed
      // step is logged and left for the next boot, and the sweep still reaches every other Crew.
      const stateOf = (instance: AgentCrewInstance) =>
        captainState(instance.captainThreadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 Captain lifecycle sweep could not read a Captain thread", {
              captainThreadId: instance.captainThreadId,
              crewInstanceId: instance.id,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
      for (const instance of yield* crews.listLive()) {
        const state = yield* stateOf(instance);
        if (state === null || state === "live") continue;
        const done =
          state === "gone"
            ? yield* retireWithRetry(instance.captainThreadId, instance)
            : yield* attempt(
                instance.captainThreadId,
                instance,
                moveSeats(instance.captainThreadId, instance, "settle", `sweep:${state.settledAt}`),
              );
        if (done) acted.push(instance.id);
      }
      for (const instance of yield* crews.listRetiredWithCaptain()) {
        const state = yield* stateOf(instance);
        if (state === null || state === "gone") continue;
        if (
          yield* attempt(
            instance.captainThreadId,
            instance,
            restore(instance.captainThreadId, instance, `sweep:${instance.archivedAt}`),
          )
        )
          acted.push(instance.id);
      }
      if (acted.length > 0)
        yield* Effect.logInfo("J5 Captain lifecycle sweep moved Crews with their Captains", {
          acted,
        });
      return acted;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("J5 Captain lifecycle sweep failed", { cause }).pipe(Effect.as([])),
      ),
    );

    return CrewCaptainArchiveCascade.of({ handleStoredEvent, reconcile });
  }),
);
