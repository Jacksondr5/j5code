import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  McpInvocationContext,
  type McpInvocationScope,
} from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AHomeRegistrar } from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { PlacementCascadeService } from "../PlacementCascadeService.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { A2ASendService } from "../SendService.ts";
import {
  CommCommandId,
  type ParticipantDirectoryRow,
  type ParticipantId,
  type SquadronId,
} from "../contracts.ts";
import { PlacementCommandId } from "../placementContracts.ts";
import { provenanceFromThreadLineage } from "../placementProvenance.ts";
import { J5Toolkit, type J5McpFailure } from "./tools.ts";

class J5PlacementMcpStateError extends Data.TaggedError("J5PlacementMcpStateError")<{
  readonly state: string;
  readonly nextCommand: string;
}> {
  override get message(): string {
    return `J5 caller membership state is ${this.state}. ${this.nextCommand}`;
  }
}

const failure = (error: unknown): J5McpFailure => ({
  code:
    typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : "J5A2AError",
  message: error instanceof Error ? error.message : String(error),
});

const stablePart = (value: string) => encodeURIComponent(value);

const placementCommandId = (input: {
  readonly providerSessionId: string;
  readonly requestKey: string;
  readonly operation: string;
}) =>
  PlacementCommandId.make(
    `command:j5:a2a:placement:mcp:${stablePart(input.providerSessionId)}:${stablePart(input.requestKey)}:${input.operation}`,
  );

const placementBackfillCommandId = (input: {
  readonly squadronId: SquadronId;
  readonly participantId: ParticipantId;
}) =>
  PlacementCommandId.make(
    `command:j5:a2a:placement:lineage:${stablePart(input.squadronId)}:${stablePart(input.participantId)}`,
  );

const spawnCommandId = (input: {
  readonly taskId: string;
  readonly operation: "home" | "placement";
}) => `command:j5:a2a:spawn:${stablePart(input.taskId)}:${input.operation}`;

export const commandIdForRequest = (input: {
  readonly providerSessionId: string;
  readonly requestKey: string;
}) =>
  CommCommandId.make(
    `command:j5:a2a:mcp:${stablePart(input.providerSessionId)}:${stablePart(input.requestKey)}`,
  );

type AgentDirectoryRow = ParticipantDirectoryRow & {
  readonly participant: Extract<ParticipantDirectoryRow["participant"], { readonly kind: "agent" }>;
};

const resolveCallerMembership = Effect.fn("j5.a2a.mcp.resolveCallerMembership")(function* (
  scope: McpInvocationScope,
) {
  const directory = yield* (yield* A2ASendService).listParticipants(scope.threadId);
  const memberships = directory.filter(
    (row): row is AgentDirectoryRow =>
      row.participant.kind === "agent" && row.participant.threadId === scope.threadId,
  );
  if (memberships.length === 0) {
    return yield* new J5PlacementMcpStateError({
      state: `missing for thread ${scope.threadId}`,
      nextCommand: "Call list_participants to inspect current Squadron membership before retrying.",
    });
  }
  if (memberships.length !== 1) {
    return yield* new J5PlacementMcpStateError({
      state: `ambiguous across current Squadrons ${memberships.map((row) => row.squadronId).join(", ")}`,
      nextCommand: "Call list_participants to inspect current Squadron membership before retrying.",
    });
  }
  return memberships[0]!;
});

const requireCallerInSquadron = Effect.fn("j5.a2a.mcp.requireCallerInSquadron")(function* (
  scope: McpInvocationScope,
  targetSquadronId: SquadronId,
  command: "stop_agent" | "archive_agent",
) {
  const caller = yield* resolveCallerMembership(scope);
  if (caller.squadronId !== targetSquadronId) {
    return yield* new J5PlacementMcpStateError({
      state: `current Squadron is ${caller.squadronId}, but ${command} targeted ${targetSquadronId}`,
      nextCommand: `Retry ${command} with squadron_id=${caller.squadronId}.`,
    });
  }
  return caller;
});

const ensureCallerPlacement = Effect.fn("j5.a2a.mcp.ensureCallerPlacement")(function* (
  scope: McpInvocationScope,
  caller: AgentDirectoryRow,
) {
  const placements = yield* ParticipantPlacementService;
  const existing = yield* placements.readPlacement({
    squadronId: caller.squadronId,
    participantId: caller.participantId,
  });
  if (existing !== null) return existing;

  const projection = yield* (yield* ThreadManagementService).getThreadProjection(scope.threadId);
  const parentThreadId = projection.thread.lineage.parentThreadId;
  const parentParticipantId =
    parentThreadId === null
      ? null
      : yield* (yield* A2ALedger).findHistoricalAgentParticipantId({
          squadronId: caller.squadronId,
          threadId: parentThreadId,
        });
  const provenance = provenanceFromThreadLineage({
    lineage: projection.thread.lineage,
    parentParticipantId,
  });
  const result = yield* placements.recordCreation({
    commandId: placementBackfillCommandId({
      squadronId: caller.squadronId,
      participantId: caller.participantId,
    }),
    squadronId: caller.squadronId,
    participantId: caller.participantId,
    actor: "platform",
    provenance,
    createdAt: String(projection.thread.createdAt),
  });
  return result.placement;
});

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
      const directory = yield* (yield* A2ASendService).listParticipants(scope.threadId);
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
          };
        }),
      };
    }).pipe(Effect.mapError(failure)),
  spawn_agent: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const caller = yield* resolveCallerMembership(scope);
      const ledger = yield* A2ALedger;
      // Fail before upstream delegation if the caller's immutable home no
      // longer names an existing Squadron.
      yield* ledger.readSquadron(caller.squadronId);
      yield* ensureCallerPlacement(scope, caller);

      const delegation = yield* (yield* OrchestratorMcpService).delegateTask(scope, input);
      const childProjection = yield* (yield* ThreadManagementService).getThreadProjection(
        delegation.childThreadId,
      );
      const createdAt = String(childProjection.thread.createdAt);
      const home = yield* (yield* A2AHomeRegistrar).registerAtCreation({
        commandId: CommCommandId.make(
          spawnCommandId({ taskId: delegation.taskId, operation: "home" }),
        ),
        squadronId: caller.squadronId,
        threadId: delegation.childThreadId,
        createdAt,
      });
      const placement = yield* (yield* ParticipantPlacementService).recordCreation({
        commandId: PlacementCommandId.make(
          spawnCommandId({ taskId: delegation.taskId, operation: "placement" }),
        ),
        squadronId: home.squadronId,
        participantId: home.participantId,
        actor: "agent",
        provenance: {
          kind: "spawned-by",
          spawnedByParticipantId: caller.participantId,
          source: "j5_wrapper",
        },
        createdAt,
      });
      return { delegation, placement: placement.placement };
    }).pipe(Effect.mapError(failure)),
  stop_agent: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      yield* requireCallerInSquadron(scope, input.squadron_id, "stop_agent");
      const cascades = yield* PlacementCascadeService;
      return {
        results: yield* cascades.stop({
          commandId: placementCommandId({
            providerSessionId: scope.providerSessionId,
            requestKey: input.client_request_id,
            operation: "stop",
          }),
          squadronId: input.squadron_id,
          participantId: input.participant_id,
        }),
      };
    }).pipe(Effect.mapError(failure)),
  archive_agent: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      yield* requireCallerInSquadron(scope, input.squadron_id, "archive_agent");
      const cascades = yield* PlacementCascadeService;
      return {
        results: yield* cascades.archive({
          commandId: placementCommandId({
            providerSessionId: scope.providerSessionId,
            requestKey: input.client_request_id,
            operation: "archive",
          }),
          squadronId: input.squadron_id,
          participantId: input.participant_id,
        }),
      };
    }).pipe(Effect.mapError(failure)),
} satisfies Parameters<typeof J5Toolkit.toLayer>[0];

export const J5ToolkitHandlersLive = J5Toolkit.toLayer(handlers);
