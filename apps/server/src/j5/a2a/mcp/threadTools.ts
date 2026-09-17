import { OrchestratorMcpFailure, ThreadId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { newCommandId, readWritableThread, unavailable } from "../../../mcp/threadAccess.ts";
import { ThreadToolkit } from "../../../mcp/toolkits/thread/tools.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { A2AHomeRegistrar } from "../HomeRegistrar.ts";
import { J5ThreadLineageError } from "../ThreadLineage.ts";

const common = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, ThreadManagementService, Crypto.Crypto, A2AHomeRegistrar],
};
export const J5AdaptedThreadToolkit = Toolkit.make(
  Tool.make("t3_thread_fork", {
    ...common,
    parameters: ThreadToolkit.tools.t3_thread_fork.parametersSchema,
    success: ThreadToolkit.tools.t3_thread_fork.successSchema,
    description:
      "Fork this thread from a stable run or checkpoint, inheriting its configuration and registered Squadron. Each call creates a new fork. If registration fails, the error identifies the durable fork and original command for operator repair; a new tool call does not retry that command.",
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_thread_merge_back", {
    ...common,
    parameters: ThreadToolkit.tools.t3_thread_merge_back.parametersSchema,
    success: ThreadToolkit.tools.t3_thread_merge_back.successSchema,
    description:
      "Merge context back to a related thread in the calling project. Both threads must share a registered Squadron, or both be native. Existing lineage and transfer rules apply.",
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_thread_organize", {
    ...common,
    parameters: ThreadToolkit.tools.t3_thread_organize.parametersSchema,
    success: ThreadToolkit.tools.t3_thread_organize.successSchema,
    description:
      "Pin, snooze, settle, archive, restore, or mark a thread unread in the calling project. Omit threadId for this thread. Archive hides the agent and closes its Exchanges; unarchive restores visibility without reopening Exchanges. Archiving another registered agent requires the same Squadron. Archive does not interrupt a running turn. snooze requires snoozedUntil.",
  }).annotate(Tool.Destructive, true),
);

const isLineageError = Schema.is(Schema.instanceOf(J5ThreadLineageError));
const lineageFailure = (cause: unknown) =>
  isLineageError(cause)
    ? new OrchestratorMcpFailure({
        code: cause.phase === "admission" ? "invalid_request" : "orchestration_error",
        message: cause.message,
      })
    : unavailable();

export const J5AdaptedThreadHandlersLive = J5AdaptedThreadToolkit.toLayer({
  t3_thread_fork: (input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readWritableThread();
      const commandId = yield* newCommandId();
      const targetThreadId = ThreadId.make(`${commandId}:fork`);
      const result = yield* threads
        .dispatch({
          type: "thread.fork",
          commandId,
          sourceThreadId: projection.thread.id,
          targetThreadId,
          sourcePoint: input.sourcePoint,
          ...(input.title === undefined ? {} : { title: input.title }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(lineageFailure));
      return { sequence: result.sequence, targetThreadId };
    }),
  t3_thread_merge_back: (input) =>
    Effect.gen(function* () {
      const { threads, caller } = yield* readWritableThread(input.targetThreadId);
      const result = yield* threads
        .dispatch({
          type: "thread.merge_back",
          commandId: yield* newCommandId(),
          sourceThreadId: caller.id,
          targetThreadId: input.targetThreadId,
          sourcePoint: input.sourcePoint,
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(lineageFailure));
      return { sequence: result.sequence, targetThreadId: input.targetThreadId };
    }),
  t3_thread_organize: (input) =>
    Effect.gen(function* () {
      const { threads, caller, projection } = yield* readWritableThread(input.threadId);
      if (
        (input.action === "archive" || input.action === "unarchive") &&
        projection.thread.id !== caller.id
      ) {
        const homes = yield* A2AHomeRegistrar;
        const homeFor = (threadId: ThreadId) =>
          homes.getHomeForThread(threadId).pipe(
            Effect.catchTag("A2AHomeNotFoundError", () => Effect.succeed(null)),
            Effect.mapError(unavailable),
          );
        const target = yield* homeFor(projection.thread.id);
        if (target !== null) {
          const callerHome = yield* homeFor(caller.id);
          if (callerHome?.squadronId !== target.squadronId)
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message: `Archiving or restoring agent ${projection.thread.id} in ${target.squadronId} requires a caller in that Squadron; the caller belongs to ${callerHome?.squadronId ?? "no registered Squadron"}.`,
            });
        }
      }
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence };
    }),
});
