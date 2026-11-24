import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Command,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService, crewArchiveThreads } from "./AgentCrewInstanceService.ts";
import { participantIdForThread } from "./HomeRegistrar.ts";

/**
 * A Crew member is never archived or deleted alone (Crews AC16); the unit retires through Archive
 * crew, `j5_archive_crew`, or its Captain's archive. Every client archive is one `dispatchCommand`,
 * so this check on that handler covers every door, and the organize MCP tool applies it too. The
 * unit paths archive seats through the lifecycle service, not this handler.
 */
class CrewSeatArchivedAloneError extends Schema.TaggedError<CrewSeatArchivedAloneError>()(
  "CrewSeatArchivedAloneError",
  {
    threadId: Schema.String,
    action: Schema.Literals(["archive", "delete"]),
    seatName: Schema.String,
    crewName: Schema.String,
    crewInstanceId: Schema.String,
  },
) {
  override get message(): string {
    return `This thread is seat ${this.seatName} of Crew ${this.crewName}. Crew members are never ${this.action === "archive" ? "archived" : "deleted"} one by one; retire the whole Crew with Archive crew on the Fleet page in J5 on web or desktop, or message the member instead.`;
  }
}

/**
 * A Captain's archive retires its Crews after upstream commits it, and upstream refuses to archive
 * a seat with running delegated tasks, so such a Captain is refused before anything is archived.
 */
class CaptainCrewDelegatingError extends Schema.TaggedError<CaptainCrewDelegatingError>()(
  "CaptainCrewDelegatingError",
  { threadId: Schema.String, crewName: Schema.String, seats: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Archiving this thread retires Crew ${this.crewName}, but seat(s) ${this.seats.join(", ")} still have running delegated tasks. Stop those seats (their tasks stop with them) or wait, then archive again. Nothing was archived.`;
  }
}

/** Upstream's own test for the archive it refuses (`hasRunningDelegatedTasks` in Orchestrator.ts). */
export const runsDelegatedTasks = (threadId: ThreadId) =>
  ThreadManagementService.use((threads) => threads.getThreadRecords(threadId, ["subagents"])).pipe(
    Effect.map(({ subagents }) =>
      subagents.some(
        (task) =>
          task.origin === "app_owned" &&
          task.childThreadId !== null &&
          isOrchestrationV2WorkActive(task.status),
      ),
    ),
  );

const guardedTarget = (
  command: OrchestrationV2Command,
): { readonly action: "archive" | "delete"; readonly threadId: ThreadId } | null =>
  command.type === "thread.archive"
    ? { action: "archive", threadId: command.threadId }
    : command.type === "thread.delete"
      ? { action: "delete", threadId: command.threadId }
      : null;

export type CrewSeatArchiveGuard = (
  command: OrchestrationV2Command,
) => Effect.Effect<void, CrewSeatArchivedAloneError | CaptainCrewDelegatingError>;

/**
 * Resolves the Crew store once and returns the per-command check. A store that cannot be read
 * never blocks the person's archive: the check logs and lets the command through, because a
 * refusal must rest on a live fact, not on an outage.
 */
export const makeCrewSeatArchiveGuard: Effect.Effect<
  CrewSeatArchiveGuard,
  never,
  AgentCrewInstanceService | ThreadManagementService
> = Effect.gen(function* () {
  const crews = yield* AgentCrewInstanceService;
  const threads = yield* ThreadManagementService;
  /** The first live Crew this Captain commands with a seat running delegated tasks, if any. */
  const delegatingCrew = Effect.fn("j5.a2a.crewSeatArchiveGuard.delegatingCrew")(function* (
    captainThreadId: ThreadId,
  ) {
    const involving = yield* crews.listInvolving({
      threadIds: [captainThreadId],
      participantIds: [participantIdForThread(captainThreadId)],
    });
    for (const instance of involving) {
      if (instance.captainThreadId !== captainThreadId || instance.archivedAt !== null) continue;
      const seats: Array<string> = [];
      for (const member of crewArchiveThreads(instance)) {
        const delegating = yield* runsDelegatedTasks(member.threadId).pipe(
          Effect.provideService(ThreadManagementService, threads),
          Effect.orElseSucceed(() => false),
        );
        if (delegating) seats.push(member.seatName);
      }
      if (seats.length > 0) return { crewName: instance.displayName, seats };
    }
    return null;
  });
  return Effect.fn("j5.a2a.crewSeatArchiveGuard")(function* (command: OrchestrationV2Command) {
    const target = guardedTarget(command);
    if (target === null) return;
    const seat = yield* Effect.gen(function* () {
      const membership = yield* crews.findMembership(participantIdForThread(target.threadId));
      if (membership === null) return null;
      const instance = yield* crews.read(membership.crewInstanceId);
      return instance === null || instance.archivedAt !== null
        ? null
        : {
            seatName: membership.seatName,
            crewName: instance.displayName,
            crewInstanceId: instance.id,
          };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("J5 crew seat archive guard could not read the Crew; allowing", {
          threadId: target.threadId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (seat !== null) return yield* new CrewSeatArchivedAloneError({ ...target, ...seat });
    if (target.action !== "archive") return;
    const delegating = yield* delegatingCrew(target.threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("J5 crew seat archive guard could not read a Captain's Crews; allowing", {
          threadId: target.threadId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (delegating === null) return;
    return yield* new CaptainCrewDelegatingError({ threadId: target.threadId, ...delegating });
  });
});
