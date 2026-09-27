import type { OrchestrationV2Command } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { OrchestratorDispatchError } from "../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { A2AHomeRegistrar } from "./HomeRegistrar.ts";
import { SpawnCompositionService } from "./SpawnCompositionService.ts";
import { registrationCommandIdForCreation } from "./SquadronThreadCreationService.ts";
import { PlacementCommandId } from "./placementContracts.ts";

// Preserve the upstream dispatch error contract while exposing the repair action
// through both HTTP/MCP error mappers, which read Error.message.
export class J5ThreadLineageError extends OrchestratorDispatchError.extend<J5ThreadLineageError>(
  "J5ThreadLineageError",
)({
  phase: Schema.Literals(["admission", "registration"]),
}) {
  override get message(): string {
    return `J5 thread lineage (${this.commandId}): ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
  }
}

export const layer = Layer.effect(
  ThreadManagementService,
  Effect.gen(function* () {
    const inner = yield* ThreadManagementService;
    const homes = yield* A2AHomeRegistrar;
    const composition = yield* SpawnCompositionService;
    const homeFor = (threadId: Parameters<typeof homes.getHomeForThread>[0]) =>
      homes
        .getHomeForThread(threadId)
        .pipe(Effect.catchTag("A2AHomeNotFoundError", () => Effect.succeed(null)));
    const dispatch = Effect.fn("J5ThreadLineage.dispatch")(function* (
      command: OrchestrationV2Command,
    ) {
      if (command.type !== "thread.fork" && command.type !== "thread.merge_back") {
        return yield* inner.dispatch(command);
      }
      const failure = (cause: unknown, phase: "admission" | "registration" = "admission") =>
        new J5ThreadLineageError({
          commandId: command.commandId,
          commandType: command.type,
          cause,
          phase,
        });
      const source = yield* homeFor(command.sourceThreadId).pipe(
        Effect.mapError((cause) => failure(cause)),
      );
      if (command.type === "thread.merge_back") {
        const target = yield* homeFor(command.targetThreadId).pipe(
          Effect.mapError((cause) => failure(cause)),
        );
        if (source?.squadronId !== target?.squadronId) {
          return yield* failure(
            new Error(
              "Merge-back requires both threads to share a registered Squadron, or both to be native. Repair missing fork registration by replaying its original fork command; do not infer a home from the project.",
            ),
          );
        }
        return yield* inner.dispatch(command);
      }
      const result = yield* inner.dispatch(command);
      // A native source stays native, regardless of which client requested it.
      if (source === null) return result;
      yield* Effect.gen(function* () {
        const target = yield* inner.getThreadProjection(command.targetThreadId);
        yield* composition.recordFacts({
          homeCommandId: registrationCommandIdForCreation(command.commandId),
          placementCommandId: PlacementCommandId.make(
            `command:j5:a2a:thread-fork-placement:${encodeURIComponent(command.commandId)}`,
          ),
          squadronId: source.squadronId,
          threadId: command.targetThreadId,
          provenance: {
            kind: "forked-from",
            sourceParticipantId: source.participantId,
            source: "upstream_lineage",
          },
          createdAt: DateTime.formatIso(target.thread.createdAt),
        });
      }).pipe(
        Effect.mapError((cause) =>
          failure(
            new Error(
              `Fork ${command.targetThreadId} exists but its Squadron registration could not complete. Replay command ${command.commandId} after repairing the cause; a new tool call creates another fork. ${cause.message}`,
            ),
            "registration",
          ),
        ),
        Effect.tapError((error) => Effect.logError(error.message)),
      );
      return result;
    });
    return ThreadManagementService.of({ ...inner, dispatch });
  }),
);
