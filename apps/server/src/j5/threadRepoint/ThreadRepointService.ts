import {
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { IdAllocatorV2 } from "../../orchestration-v2/IdAllocator.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";

export class ThreadRepointError extends Schema.TaggedErrorClass<ThreadRepointError>()(
  "ThreadRepointError",
  {
    threadId: ThreadId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Cannot repoint thread ${this.threadId}: ${this.detail}`;
  }
}

const isThreadRepointError = Schema.is(ThreadRepointError);

export class NativeThreadValidationError extends Schema.TaggedErrorClass<NativeThreadValidationError>()(
  "NativeThreadValidationError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const isTerminalRun = (status: string) =>
  status === "completed" ||
  status === "interrupted" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "rolled_back";

export type NativeThreadValidator = (input: {
  readonly driver: ProviderDriverKind;
  readonly nativeId: string;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly cwd: string | null;
}) => Effect.Effect<void, NativeThreadValidationError>;

export interface ThreadRepointServiceShape {
  readonly repoint: (input: {
    readonly threadId: ThreadId;
    readonly nativeId: string;
  }) => Effect.Effect<
    {
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly driver: ProviderDriverKind;
      readonly nativeId: string;
    },
    ThreadRepointError
  >;
}

export class ThreadRepointService extends Context.Service<
  ThreadRepointService,
  ThreadRepointServiceShape
>()("t3/j5/threadRepoint/ThreadRepointService") {}

export const layer = (
  validateNative: NativeThreadValidator,
): Layer.Layer<ThreadRepointService, never, EventSinkV2 | IdAllocatorV2 | ProjectionStoreV2> =>
  Layer.effect(
    ThreadRepointService,
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const projections = yield* ProjectionStoreV2;

      return ThreadRepointService.of({
        repoint: (input) =>
          Effect.gen(function* () {
            const nativeId = input.nativeId.trim();
            if (nativeId.length === 0) {
              return yield* new ThreadRepointError({
                threadId: input.threadId,
                detail: "Native thread id must not be empty.",
              });
            }

            const projection = yield* projections.getThreadProjection(input.threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new ThreadRepointError({
                    threadId: input.threadId,
                    detail: "Thread projection could not be read.",
                    cause,
                  }),
              ),
            );
            const runningRun = projection.runs.find((run) => !isTerminalRun(run.status));
            if (runningRun !== undefined) {
              return yield* new ThreadRepointError({
                threadId: input.threadId,
                detail: `Run ${runningRun.id} is ${runningRun.status}; wait for it to settle before repointing.`,
              });
            }

            const providerThread = projection.providerThreads.find(
              (candidate) => candidate.id === projection.thread.activeProviderThreadId,
            );
            if (providerThread === undefined) {
              return yield* new ThreadRepointError({
                threadId: input.threadId,
                detail: "The thread has no active provider thread to repoint.",
              });
            }

            yield* validateNative({
              driver: providerThread.driver,
              nativeId,
              providerThread,
              cwd:
                projection.providerSessions.find(
                  (session) => session.id === providerThread.providerSessionId,
                )?.cwd ?? projection.thread.worktreePath,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ThreadRepointError({
                    threadId: input.threadId,
                    detail: `Native ${providerThread.driver} thread ${nativeId} did not validate.`,
                    cause,
                  }),
              ),
            );

            const now = yield* DateTime.now;
            const previousNativeId = providerThread.nativeThreadRef?.nativeId ?? "none";
            const updatedProviderThread = {
              ...providerThread,
              // The validation probe is deliberately short lived. Do not present its
              // session as resident; the next turn opens and resumes normally.
              providerSessionId: null,
              status: "not_loaded" as const,
              nativeThreadRef: {
                driver: providerThread.driver,
                nativeId,
                strength: "strong" as const,
              },
              updatedAt: now,
            } satisfies OrchestrationV2ProviderThread;
            const nextOrdinal =
              Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1;
            const fact = {
              id: TurnItemId.make(`turn-item:operator-repoint:${providerThread.id}:${nativeId}`),
              threadId: input.threadId,
              runId: null,
              nodeId: null,
              providerThreadId: providerThread.id,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: nextOrdinal,
              status: "completed" as const,
              title: "Native thread repointed",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "command_execution" as const,
              input: `t3 thread repoint ${input.threadId} --native ${nativeId}`,
              output: `Repointed ${providerThread.driver} native thread from ${previousNativeId} to ${nativeId} after validation.`,
            };

            yield* eventSink
              .write({
                events: [
                  {
                    id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
                    type: "provider-thread.updated",
                    threadId: input.threadId,
                    driver: providerThread.driver,
                    providerInstanceId: providerThread.providerInstanceId,
                    occurredAt: now,
                    payload: updatedProviderThread,
                  },
                  {
                    id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
                    type: "turn-item.updated",
                    threadId: input.threadId,
                    driver: providerThread.driver,
                    providerInstanceId: providerThread.providerInstanceId,
                    occurredAt: now,
                    payload: fact,
                  },
                ],
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ThreadRepointError({
                      threadId: input.threadId,
                      detail: "Validated re-point could not be persisted.",
                      cause,
                    }),
                ),
              );

            return { providerThreadId: providerThread.id, driver: providerThread.driver, nativeId };
          }).pipe(
            Effect.mapError((cause) =>
              isThreadRepointError(cause)
                ? cause
                : new ThreadRepointError({
                    threadId: input.threadId,
                    detail: "Validated re-point could not be completed.",
                    cause,
                  }),
            ),
          ),
      });
    }),
  );
