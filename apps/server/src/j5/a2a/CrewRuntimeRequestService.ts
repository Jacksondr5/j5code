import {
  type CommandId,
  type OrchestrationV2ThreadProjection,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import type { CrewRuntimeRequestItem } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService, type AgentCrewInstance } from "./AgentCrewInstanceService.ts";

/** The thread a request lives on, and where it sits in its Crew. */
interface CrewThread {
  readonly threadId: ThreadId;
  readonly crew: AgentCrewInstance;
  /** Null for the Captain's own thread. */
  readonly seat: string | null;
}

/**
 * Pending provider approvals and questions on one thread, the same selection the web composer
 * shows inline (`derivePendingThreadRequests` in client-runtime, which the server cannot import):
 * pending requests only, questions with their `user_input_request` item, and approvals minus
 * `auth_refresh` and `dynamic_tool_call`, which are not the person's to answer.
 */
export const pendingCrewThreadRequests = (
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): ReadonlyArray<
  Pick<CrewRuntimeRequestItem, "requestId" | "createdAt" | "responseCapability" | "request">
> =>
  projection.runtimeRequests.flatMap((request) => {
    if (request.status !== "pending") return [];
    const base = {
      requestId: request.id,
      createdAt: DateTime.formatIso(request.createdAt),
      responseCapability: request.responseCapability.type,
    };
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      return item?.type === "user_input_request"
        ? [{ ...base, request: { kind: "user_input" as const, questions: item.questions } }]
        : [];
    }
    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") return [];
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    const approval = item?.type === "approval_request" ? item : undefined;
    return [
      {
        ...base,
        request: {
          kind: "approval" as const,
          requestKind: request.kind,
          detail: approval?.prompt || null,
          appName: approval?.appName || null,
          options: approval?.options ?? null,
        },
      },
    ];
  });

/** The orchestrator's own reason when it gave one, rather than its generic dispatch message. */
const dispatchReason = (error: unknown): string => {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  if (typeof record.cause === "string" && record.cause.length > 0) return record.cause;
  return typeof record.message === "string" ? record.message : String(error);
};

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
  readonly list: Effect.Effect<ReadonlyArray<CrewRuntimeRequestItem>>;
  readonly respond: (
    input: RespondToCrewRuntimeRequestInput,
  ) => Effect.Effect<
    void,
    | CrewRuntimeRequestNotFoundError
    | CrewRuntimeRequestConflictError
    | CrewRuntimeRequestInvalidError
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

    /** A reserved seat may have no thread yet, and an archived one takes no answers. */
    const liveProjection = (threadId: ThreadId) =>
      threads.getThreadProjection(threadId).pipe(
        Effect.map((projection) => (projection.thread.archivedAt === null ? projection : null)),
        Effect.catchCause(() => Effect.succeed(null)),
      );

    const list: CrewRuntimeRequestServiceShape["list"] = Effect.gen(function* () {
      const items: Array<CrewRuntimeRequestItem> = [];
      for (const entry of yield* liveCrewThreads) {
        const projection = yield* liveProjection(entry.threadId);
        if (projection === null) continue;
        for (const pending of pendingCrewThreadRequests(projection))
          items.push({
            ...pending,
            threadId: entry.threadId,
            crewInstanceId: entry.crew.id,
            crewName: entry.crew.displayName,
            squadronId: entry.crew.squadronId,
            seat: entry.seat,
            threadTitle: projection.thread.title,
          });
      }
      return items.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("J5 crew runtime request read failed", { cause }).pipe(Effect.as([])),
      ),
    );

    const respond: CrewRuntimeRequestServiceShape["respond"] = (input) =>
      Effect.gen(function* () {
        const notFound = new CrewRuntimeRequestNotFoundError({
          threadId: input.threadId,
          requestId: input.requestId,
        });
        const onCrew = (yield* liveCrewThreads.pipe(Effect.orElseSucceed(() => []))).some(
          (entry) => entry.threadId === input.threadId,
        );
        if (!onCrew) return yield* notFound;
        const projection = yield* liveProjection(input.threadId);
        if (projection === null) return yield* notFound;
        const request = projection.runtimeRequests.find((entry) => entry.id === input.requestId);
        if (request === undefined) return yield* notFound;
        if (request.status !== "pending")
          return yield* new CrewRuntimeRequestConflictError({
            detail: `This request is already ${request.status}; it may have been answered on another device.`,
          });
        if (
          request.kind === "user_input" ? input.answers === undefined : input.decision === undefined
        )
          return yield* new CrewRuntimeRequestInvalidError({
            detail:
              request.kind === "user_input"
                ? "Answering a question requires answers."
                : "Answering an approval requires a decision.",
          });
        yield* threads
          .dispatch({
            type: "runtime-request.respond",
            commandId: input.commandId,
            threadId: input.threadId,
            requestId: input.requestId,
            ...(request.kind === "user_input"
              ? { answers: input.answers }
              : { decision: input.decision }),
          })
          .pipe(
            // The orchestrator refuses a request that resolved between our read and this command;
            // its reason ("... is resolved", "Provider session ... was not found") rides in `cause`.
            Effect.mapError(
              (error) =>
                new CrewRuntimeRequestConflictError({
                  detail: `The request could not be answered: ${dispatchReason(error)}`,
                }),
            ),
          );
      });

    return CrewRuntimeRequestService.of({ list, respond });
  }),
);
