import type { OrchestrationV2StoredEvent, ThreadId } from "@t3tools/contracts";
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
   * When a committed archive or deletion lands on a thread that commands live Crews, retire
   * those Crews as units. Returns the ids retired, or null when the event was not a Captain's.
   */
  readonly handleStoredEvent: (
    stored: OrchestrationV2StoredEvent,
  ) => Effect.Effect<ReadonlyArray<string> | null>;
  /**
   * The boot sweep: retire every live Crew whose Captain thread is already archived or gone.
   * Covers a cascade that failed partway (the loop logs and moves on, so nothing else retries
   * it) and an archive that landed while the server was down, since the event stream resumes
   * from its high-water mark. Returns the ids retired.
   */
  readonly reconcile: Effect.Effect<ReadonlyArray<string>>;
}

export class CrewCaptainArchiveCascade extends Context.Service<
  CrewCaptainArchiveCascade,
  CrewCaptainArchiveCascadeShape
>()("t3/j5/a2a/CrewCaptainArchiveCascade") {}

/**
 * A Captain is never archived alone (Crews AC17). Agents are refused up front: `archive_agent`
 * names the Crew to retire first. A person's archive cannot be refused after the fact, because
 * upstream's `thread.archive` has already committed by the time J5 sees it, from the web sidebar,
 * a mobile swipe, or any future door. So the one place that sees every archive compensates: the
 * live Crews the thread commanded retire as units through the same service the Captain and the
 * Fleet page use, with the person's act as the confirmation. Command ids derive from the Captain
 * and the Crew, so a replayed event converges on the same commands and an already retired Crew
 * replays as already archived.
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

    const handleStoredEvent: CrewCaptainArchiveCascadeShape["handleStoredEvent"] = (stored) =>
      Effect.gen(function* () {
        const event = stored.event;
        if (event.type !== "thread.archived" && event.type !== "thread.deleted") return null;
        const threadId = event.threadId;
        // Placement and membership rows may already be gone for a deleted thread; the Crew
        // record names its Captain's thread directly, so the lookup needs no home.
        const involving = yield* crews.listInvolving({
          threadIds: [threadId],
          participantIds: [participantIdForThread(threadId)],
        });
        const commanded = involving.filter(
          (instance) => instance.captainThreadId === threadId && instance.archivedAt === null,
        );
        if (commanded.length === 0) return null;
        for (const instance of commanded) {
          yield* retire(threadId, instance).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("J5 Captain archive cascade failed; the Crew stays live", {
                captainThreadId: threadId,
                crewInstanceId: instance.id,
                cause,
              }),
            ),
          );
        }
        return commanded.map((instance) => instance.id);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 Captain archive cascade skipped", { cause }).pipe(Effect.as(null)),
        ),
      );

    /**
     * Archived or deleted: either way the Captain no longer commands, so its Crews retire. A
     * deleted thread keeps its projection with `deletedAt` set, so both read as facts; a
     * projection that cannot be read is the store's problem and leaves the Crew alone this pass.
     */
    const captainIsGone = Effect.fn("j5.a2a.captainArchiveCascade.captainIsGone")(function* (
      instance: AgentCrewInstance,
    ) {
      const read = yield* Effect.result(threads.getThreadProjection(instance.captainThreadId));
      if (Result.isSuccess(read))
        return read.success.thread.archivedAt !== null || read.success.thread.deletedAt !== null;
      yield* Effect.logWarning("J5 Captain archive sweep could not read a Captain thread", {
        captainThreadId: instance.captainThreadId,
        crewInstanceId: instance.id,
        cause: read.failure,
      });
      return false;
    });

    const reconcile: CrewCaptainArchiveCascadeShape["reconcile"] = Effect.gen(function* () {
      const live = yield* crews.listLive();
      const retired: Array<string> = [];
      for (const instance of live) {
        // A defect while reading one Captain skips that Crew, not the sweep.
        const gone = yield* captainIsGone(instance).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 Captain archive sweep could not read a Captain thread", {
              captainThreadId: instance.captainThreadId,
              crewInstanceId: instance.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (!gone) continue;
        // One Crew's failed retirement (a seat that would not archive, a store hiccup) is logged
        // and left for the next boot; the sweep still reaches every other orphaned Crew.
        const done = yield* retire(instance.captainThreadId, instance).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 Captain archive sweep could not retire a Crew", {
              captainThreadId: instance.captainThreadId,
              crewInstanceId: instance.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (done) retired.push(instance.id);
      }
      if (retired.length > 0)
        yield* Effect.logInfo("J5 Captain archive sweep retired orphaned Crews", { retired });
      return retired;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("J5 Captain archive sweep failed", { cause }).pipe(Effect.as([])),
      ),
    );

    return CrewCaptainArchiveCascade.of({ handleStoredEvent, reconcile });
  }),
);
