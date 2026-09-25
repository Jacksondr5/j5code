import {
  type CommandId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import type { CrewRuntimeRequestItem } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { pendingCrewThreadRequests } from "@t3tools/shared/j5/crewRuntimeRequests";
import type { OrchestratorV2Error } from "../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";
import { getThreadProjectionIfPresent } from "./threadProjectionReads.ts";

/** The thread a request lives on, and where it sits in its Crew. */
interface CrewThread {
  readonly threadId: ThreadId;
  readonly crew: AgentCrewInstance;
  /** Null for the Captain's own thread. */
  readonly seat: string | null;
}

export { pendingCrewThreadRequests } from "@t3tools/shared/j5/crewRuntimeRequests";

export class CrewRuntimeRequestNotFoundError extends Data.TaggedError(
  "CrewRuntimeRequestNotFoundError",
)<{ readonly threadId: ThreadId; readonly requestId: RuntimeRequestId }> {
  override get message() {
    return `No pending request ${this.requestId} on a live Crew thread ${this.threadId}.`;
  }
}

/** The request exists but can no longer take this answer: answered, expired, or not resumable. */
export class CrewRuntimeRequestConflictError extends Data.TaggedError(
  "CrewRuntimeRequestConflictError",
)<{ readonly detail: string }> {
  override get message() {
    return this.detail;
  }
}

export class CrewRuntimeRequestInvalidError extends Data.TaggedError(
  "CrewRuntimeRequestInvalidError",
)<{ readonly detail: string }> {
  override get message() {
    return this.detail;
  }
}

/** The answer could not be sent for a reason other than the request's state; the route logs it. */
export class CrewRuntimeRequestDispatchError extends Data.TaggedError(
  "CrewRuntimeRequestDispatchError",
)<{ readonly cause: OrchestratorV2Error }> {
  override get message() {
    return "The answer could not be sent.";
  }
}

/** Reading the Crews or a thread failed; never read as "nothing pending" or "not found". */
type CrewRuntimeRequestReadError = SqlError | OrchestratorV2Error;

export interface RespondToCrewRuntimeRequestInput {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly decision?: ProviderApprovalDecision;
  readonly answers?: ProviderUserInputAnswers;
  /** Fresh per answer, so a second answer is refused by the request's state, not deduplicated. */
  readonly commandId: CommandId;
}

export interface CrewRuntimeRequestServiceShape {
  /** Every pending approval and question on a live Crew's Captain and seat threads. */
  readonly list: Effect.Effect<ReadonlyArray<CrewRuntimeRequestItem>, CrewRuntimeRequestReadError>;
  readonly respond: (
    input: RespondToCrewRuntimeRequestInput,
  ) => Effect.Effect<
    void,
    | CrewRuntimeRequestNotFoundError
    | CrewRuntimeRequestConflictError
    | CrewRuntimeRequestInvalidError
    | CrewRuntimeRequestDispatchError
    | CrewRuntimeRequestReadError
  >;
}

export class CrewRuntimeRequestService extends Context.Service<
  CrewRuntimeRequestService,
  CrewRuntimeRequestServiceShape
>()("t3/j5/a2a/CrewRuntimeRequestService") {}

/**
 * Anything a Crew's Captain or seat needs from the person reaches the Inbox (Crews AC9), so
 * provider approvals and questions on those threads are read here and answered through the same
 * `runtime-request.respond` command the composer sends. The initial roster card is not a provider
 * request and stays inline. Only live Crews count: a retired Crew's threads leave the list, and a
 * thread outside every live Crew is never listed or answered here.
 */
export const layer = Layer.effect(
  CrewRuntimeRequestService,
  Effect.gen(function* () {
    const crews = yield* AgentCrewInstanceService;
    const threads = yield* ThreadManagementService;

    const liveCrewThreads = crews.listLive().pipe(
      Effect.map((live) =>
        live.flatMap((crew): Array<CrewThread> => [
          { threadId: crew.captainThreadId, crew, seat: null },
          ...crew.members.map((member) => ({
            threadId: member.threadId,
            crew,
            seat: member.seatName,
          })),
        ]),
      ),
    );

    /**
     * A reserved seat may have no thread yet, and an archived one takes no answers; both read as
     * null. Any other store failure propagates, so an outage is an error, not an empty Inbox.
     */
    const liveProjection = (threadId: ThreadId) =>
      getThreadProjectionIfPresent(threads, threadId).pipe(
        Effect.map((projection) =>
          projection !== null && projection.thread.archivedAt === null ? projection : null,
        ),
      );

    const list: CrewRuntimeRequestServiceShape["list"] = Effect.gen(function* () {
      const entries = yield* liveCrewThreads;
      // Independent reads, so a Crew's threads are read side by side rather than one by one.
      const perThread = yield* Effect.forEach(
        entries,
        (entry) =>
          liveProjection(entry.threadId).pipe(
            Effect.map((projection): Array<CrewRuntimeRequestItem> =>
              projection === null
                ? []
                : pendingCrewThreadRequests(projection).map((pending) => ({
                    ...pending,
                    threadId: entry.threadId,
                    crewInstanceId: entry.crew.id,
                    crewName: entry.crew.displayName,
                    squadronId: entry.crew.squadronId,
                    seat: entry.seat,
                    threadTitle: projection.thread.title,
                  })),
            ),
          ),
        { concurrency: 8 },
      );
      return perThread
        .flat()
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
    });

    const respond: CrewRuntimeRequestServiceShape["respond"] = (input) =>
      Effect.gen(function* () {
        const notFound = new CrewRuntimeRequestNotFoundError({
          threadId: input.threadId,
          requestId: input.requestId,
        });
        const onCrew = (yield* liveCrewThreads).some((entry) => entry.threadId === input.threadId);
        if (!onCrew) return yield* notFound;
        const projection = yield* liveProjection(input.threadId);
        if (projection === null) return yield* notFound;
        // The same selection `list` shows, so a request the Inbox never listed is never answered.
        const pending = pendingCrewThreadRequests(projection).find(
          (entry) => entry.requestId === input.requestId,
        );
        if (pending === undefined) {
          const resolved = projection.runtimeRequests.find(
            (entry) => entry.id === input.requestId && entry.status !== "pending",
          );
          if (resolved === undefined) return yield* notFound;
          return yield* new CrewRuntimeRequestConflictError({
            detail: `This request is already ${resolved.status}; it may have been answered on another device.`,
          });
        }
        if (pending.responseCapability !== "live")
          return yield* new CrewRuntimeRequestConflictError({
            detail:
              pending.responseCapability === "message"
                ? "This question is answered by sending a message; answer it in its thread."
                : "This request can no longer be answered; open its thread to see where it stopped.",
          });
        const isQuestion = pending.request.kind === "user_input";
        if (isQuestion ? input.answers === undefined : input.decision === undefined)
          return yield* new CrewRuntimeRequestInvalidError({
            detail: isQuestion
              ? "Answering a question requires answers."
              : "Answering an approval requires a decision.",
          });
        yield* threads
          .dispatch({
            type: "runtime-request.respond",
            commandId: input.commandId,
            threadId: input.threadId,
            requestId: input.requestId,
            ...(isQuestion ? { answers: input.answers } : { decision: input.decision }),
          })
          .pipe(
            // The decider refuses with its reason as a string ("... is resolved", "Provider session
            // ... was not found"): a conflict the person can read. Any other cause is a failure to
            // send, reported as one.
            Effect.mapError((error) =>
              (error._tag === "OrchestratorDispatchError" ||
                error._tag === "OrchestratorCommandRejectedError") &&
              typeof error.cause === "string"
                ? new CrewRuntimeRequestConflictError({
                    detail: `The request could not be answered: ${error.cause}`,
                  })
                : new CrewRuntimeRequestDispatchError({ cause: error }),
            ),
          );
      });

    return CrewRuntimeRequestService.of({ list, respond });
  }),
);
