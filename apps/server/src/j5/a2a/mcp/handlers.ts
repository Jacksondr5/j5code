import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { A2ASendService } from "../SendService.ts";
import { CommCommandId } from "../contracts.ts";
import { J5Toolkit, type J5McpFailure } from "./tools.ts";

const failure = (error: unknown): J5McpFailure => ({
  code:
    typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : "J5A2AError",
  message: error instanceof Error ? error.message : String(error),
});

const stablePart = (value: string) => encodeURIComponent(value);

export const commandIdForRequest = (input: {
  readonly providerSessionId: string;
  readonly requestKey: string;
}) =>
  CommCommandId.make(
    `command:j5:a2a:mcp:${stablePart(input.providerSessionId)}:${stablePart(input.requestKey)}`,
  );

const handlers = {
  send_message: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const crypto = yield* Crypto.Crypto;
      const service = yield* A2ASendService;
      const worker = yield* A2ADeliveryWorker;
      const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4);
      const result = yield* service.send({
        commandId: commandIdForRequest({
          providerSessionId: scope.providerSessionId,
          requestKey,
        }),
        senderThreadId: scope.threadId,
        to: input.to,
        message: input.message,
        ...(input.expect_reply === undefined ? {} : { expectReply: input.expect_reply }),
        ...(input.exchange_id === undefined ? {} : { exchangeId: input.exchange_id }),
        ...(input.intent === undefined ? {} : { intent: input.intent }),
        ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
        acceptedAt,
      });
      yield* worker.notify;
      return result;
    }).pipe(Effect.mapError(failure)),
  list_participants: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* A2ASendService;
      const orchestrator = yield* OrchestratorV2;
      const directory = yield* service.listParticipants(scope.threadId);
      const placements = yield* ParticipantPlacementService;
      const squadronIds = [...new Set(directory.map((row) => row.squadronId))];
      const placementRows = (yield* Effect.forEach(
        squadronIds,
        (squadronId) => placements.listParticipants(squadronId),
        { concurrency: 1 },
      )).flat();
      const placementByParticipant = new Map(
        placementRows.map((row) => [`${row.squadronId}\u0000${row.participantId}`, row] as const),
      );
      const snapshot = yield* Effect.option(orchestrator.getShellSnapshot());
      const titleByThreadId = new Map(
        Option.match(snapshot, {
          onNone: () => [],
          onSome: ({ archivedThreads, threads }) =>
            [...threads, ...archivedThreads].map((thread) => [thread.id, thread.title] as const),
        }),
      );
      return {
        participants: directory.map((row) => {
          const placement = placementByParticipant.get(
            `${row.squadronId}\u0000${row.participantId}`,
          );
          return {
            ...row,
            threadId: row.participant.kind === "agent" ? row.participant.threadId : null,
            provenance:
              placement?.provenance ??
              (row.participant.kind === "human"
                ? ({ kind: "not-applicable" } as const)
                : ({ kind: "unrecorded" } as const)),
            placementParentId: placement?.placementParentId ?? null,
            display_name:
              row.participant.kind === "agent"
                ? (titleByThreadId.get(row.participant.threadId) ?? null)
                : null,
          };
        }),
      };
    }).pipe(Effect.mapError(failure)),
} satisfies Parameters<typeof J5Toolkit.toLayer>[0];

export const J5ToolkitHandlersLive = J5Toolkit.toLayer(handlers);
