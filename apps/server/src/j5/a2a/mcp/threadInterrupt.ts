import {
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadInterruptInput,
  type OrchestratorMcpThreadInterruptResult,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import { McpInvocationContext, requireThreadScope } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { AgentCrewInstanceService } from "../AgentCrewInstanceService.ts";
import { participantIdForThread } from "../HomeRegistrar.ts";
import { lifecycleCommandId } from "../spawnIds.ts";
import { agentStopReason, stopThread } from "../stopThread.ts";

/** Whether the calling thread is the Captain of the live Crew seat the target thread holds. */
const callerIsTargetsCaptain = Effect.fn("j5.mcp.callerIsTargetsCaptain")(
  function* (input: OrchestratorMcpThreadInterruptInput) {
    const scope = yield* McpInvocationContext;
    if (scope.thread === undefined) return false;
    const crews = yield* AgentCrewInstanceService;
    const seat = yield* crews.findMembership(participantIdForThread(input.threadId));
    const crew = seat === null ? null : yield* crews.read(seat.crewInstanceId);
    return crew?.captainParticipantId === participantIdForThread(scope.thread.threadId);
  },
  Effect.mapError(
    (error) =>
      new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: `The Crews cannot be read to check who commands this thread: ${error.message}`,
      }),
  ),
);

/** Upstream's interrupt with no mode check: a Captain commands its own seats whatever their modes. */
const captainInterrupt = Effect.fn("j5.mcp.captainInterrupt")(function* (
  input: OrchestratorMcpThreadInterruptInput,
) {
  const scope = yield* requireThreadScope(yield* McpInvocationContext, "t3_thread_interrupt");
  const threads = yield* ThreadManagementService;
  const requestKey =
    input.clientRequestId ??
    (yield* SecureRandom.SecureRandom.pipe(
      Effect.flatMap((crypto) => crypto.uuidV4()),
      Effect.orDie,
    ));
  const commandId = (operation: string) =>
    lifecycleCommandId({
      providerSessionId: scope.thread.providerSessionId,
      requestKey,
      operation,
    });
  const failed = (error: { readonly message: string }) =>
    new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: `Unable to stop thread ${input.threadId}: ${error.message}`,
    });
  const reason = agentStopReason(input.reason);
  if (input.stop === true) {
    const stopped = yield* stopThread(threads, {
      commandId: commandId("thread-stop"),
      threadId: input.threadId,
      reason,
    }).pipe(Effect.mapError(failed));
    // As upstream reads it: the run this Stop interrupted, from its own events.
    const interrupted = stopped.storedEvents.find(
      ({ event }) =>
        (event.type === "run.updated" && event.payload.status === "interrupted") ||
        (event.type === "turn-item.updated" &&
          event.payload.type === "run_interrupt_request" &&
          event.payload.providerTurnId !== null),
    )?.event.runId;
    return {
      threadId: input.threadId,
      runId: interrupted ?? null,
      status: interrupted === undefined ? "no_active_run" : "interrupt_requested",
    } satisfies OrchestratorMcpThreadInterruptResult;
  }
  const shell = yield* threads.getThreadShell(input.threadId).pipe(Effect.mapError(failed));
  if (shell === null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: `Thread ${input.threadId} was not found.`,
    });
  }
  const result = yield* threads
    .interruptThread({
      projectId: shell.projectId,
      commandId: commandId("thread-interrupt"),
      threadId: input.threadId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      reason,
    })
    .pipe(Effect.mapError(failed));
  return {
    threadId: input.threadId,
    runId: result.type === "no_active_run" ? null : result.run.id,
    status:
      result.type === "no_active_run"
        ? "no_active_run"
        : result.type === "already_terminal"
          ? result.run.status
          : "interrupt_requested",
  } satisfies OrchestratorMcpThreadInterruptResult;
});

/**
 * Upstream's `t3_thread_interrupt` with J5's one rule (register D2): a Captain stopping a seat of
 * its own Crew skips upstream's check that the target runs within the caller's modes. Every other
 * caller gets upstream's declaration and handler.
 */
export const threadInterrupt = McpToolAccess.eitherBy(
  callerIsTargetsCaptain,
  McpToolAccess.actsAsCaller(captainInterrupt),
  McpToolAccess.writesThreads(
    (input: OrchestratorMcpThreadInterruptInput) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext;
        const service = yield* OrchestratorMcpService;
        // Upstream's Stop passes the reason as given, so without one it reads as the user's.
        return yield* service.interruptThread(
          scope,
          input.stop === true ? { ...input, reason: agentStopReason(input.reason) } : input,
        );
      }),
  ),
);
