import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";

/**
 * Archive, unarchive and delete as one call each, for tests that drive a thread's lifecycle.
 * Stands in for upstream's ThreadLifecycleService, which pingdotgg/t3code#26238 deleted.
 */
export class ThreadLifecycleService extends Context.Service<
  ThreadLifecycleService,
  Record<
    "archive" | "unarchive" | "delete",
    (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<
      void,
      Effect.Error<ReturnType<ThreadManagementService["Service"]["dispatch"]>>
    >
  >
>()("t3/j5/test-support/threadLifecycle/ThreadLifecycleService") {}

export const layer = Layer.effect(
  ThreadLifecycleService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const dispatch =
      (type: "thread.archive" | "thread.unarchive" | "thread.delete") =>
      (input: { readonly commandId: CommandId; readonly threadId: ThreadId }) =>
        threads
          .dispatch({ type, commandId: input.commandId, threadId: input.threadId })
          .pipe(Effect.asVoid);
    return ThreadLifecycleService.of({
      archive: dispatch("thread.archive"),
      unarchive: dispatch("thread.unarchive"),
      delete: dispatch("thread.delete"),
    });
  }),
);
