import { CommandId, MessageId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  McpInvocationContext,
  type McpInvocationScope,
} from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  ArchiveAgentConfirmationRequiredError,
  ArchiveAgentConfirmationStaleError,
  ArchiveAgentPartialFailureError,
  ArchiveAgentService,
  type ArchiveAgentConsequenceFacts,
  type ArchiveAgentTarget,
} from "../ArchiveAgentService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AHomeRegistrar, participantIdForThread } from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { A2ASendService } from "../SendService.ts";
import { SpawnCompositionService } from "../SpawnCompositionService.ts";
import {
  CommCommandId,
  type LedgerCursor,
  type ParticipantDirectoryRow,
  type ParticipantId,
  type SquadronId,
  type StoredCommEvent,
} from "../contracts.ts";
import { PlacementCommandId, type ParticipantProvenanceView } from "../placementContracts.ts";
import { J5Toolkit, type J5ArchiveAgentFailure, type J5McpFailure } from "./tools.ts";

class J5AgentToolStateError extends Data.TaggedError("J5AgentToolStateError")<{
  readonly state: string;
  readonly nextCommand: string;
}> {
  override get message(): string {
    return `${this.state} ${this.nextCommand}`;
  }
}

const failure = (error: unknown): J5McpFailure => ({
  code:
    typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : "J5A2AError",
  message: error instanceof Error ? error.message : String(error),
});

const projectArchiveFacts = (facts: ArchiveAgentConsequenceFacts) => ({
  open_exchanges: facts.openExchanges.map((exchange) => ({
    exchange_id: exchange.exchangeId,
    direction: exchange.direction,
    reply_obligation: exchange.replyObligation,
    counterparty_id: exchange.counterpartyId,
    intent: exchange.intent,
    urgency: exchange.urgency,
    opened_at: exchange.openedAt,
  })),
  running_turn:
    facts.runningTurn === null
      ? null
      : { run_id: facts.runningTurn.runId, status: facts.runningTurn.status },
});

const archiveFailure = (error: unknown): J5ArchiveAgentFailure => {
  const base = failure(error);
  if (
    error instanceof ArchiveAgentConfirmationRequiredError ||
    error instanceof ArchiveAgentConfirmationStaleError
  ) {
    return {
      ...base,
      ...projectArchiveFacts(error.facts),
      confirmation_token: error.confirmationToken,
    };
  }
  if (error instanceof ArchiveAgentPartialFailureError) {
    return {
      ...base,
      interrupt_requested: error.interruptRequested,
      thread_archive_committed: error.threadArchived,
      participant_retired: error.participantRetired,
      pending_exchange_ids: [...error.pendingExchangeIds],
      running_turn:
        error.runningTurn === null
          ? null
          : { run_id: error.runningTurn.runId, status: error.runningTurn.status },
    };
  }
  return base;
};

const stablePart = (value: string) => encodeURIComponent(value);

const projectProvenance = (provenance: ParticipantProvenanceView) => {
  switch (provenance.kind) {
    case "spawned-by":
      return {
        kind: provenance.kind,
        spawned_by_participant_id: provenance.spawnedByParticipantId,
        source: provenance.source,
      } as const;
    case "forked-from":
      return {
        kind: provenance.kind,
        source_participant_id: provenance.sourceParticipantId,
        source: provenance.source,
      } as const;
    default:
      return provenance;
  }
};

const lifecycleId = (input: {
  readonly kind: "command" | "message" | "thread";
  readonly providerSessionId: string;
  readonly requestKey: string;
  readonly operation: string;
}) =>
  [
    input.kind,
    "j5",
    "a2a",
    "mcp",
    stablePart(input.providerSessionId),
    stablePart(input.operation),
    stablePart(input.requestKey),
  ].join(":");

const lifecycleCommandId = (input: {
  readonly providerSessionId: string;
  readonly requestKey: string;
  readonly operation: string;
}) => CommandId.make(lifecycleId({ kind: "command", ...input }));

const spawnThreadId = (input: {
  readonly providerSessionId: string;
  readonly requestKey: string;
}) => ThreadId.make(lifecycleId({ kind: "thread", operation: "spawn", ...input }));

const spawnMessageId = (input: {
  readonly providerSessionId: string;
  readonly requestKey: string;
}) => MessageId.make(lifecycleId({ kind: "message", operation: "spawn-brief", ...input }));

const spawnHomeCommandId = (input: {
  readonly providerSessionId: string;
  readonly requestKey: string;
}) => CommCommandId.make(lifecycleId({ kind: "command", operation: "spawn-home", ...input }));

const spawnPlacementCommandId = (input: {
  readonly providerSessionId: string;
  readonly requestKey: string;
}) =>
  PlacementCommandId.make(lifecycleId({ kind: "command", operation: "spawn-placement", ...input }));

export const commandIdForRequest = (input: {
  readonly toolName: "send_message" | "clear_own_ask";
  readonly providerSessionId: string;
  readonly requestKey: string;
}) => {
  // send_message already shipped with the unqualified form, so it remains the legacy namespace
  // to preserve retries across upgrades. Every later mutating tool gets an explicit namespace.
  const toolNamespace = input.toolName === "send_message" ? "" : `:${stablePart(input.toolName)}`;
  return CommCommandId.make(
    `command:j5:a2a:mcp:${stablePart(input.providerSessionId)}${toolNamespace}:${stablePart(input.requestKey)}`,
  );
};

type AgentDirectoryRow = ParticipantDirectoryRow & {
  readonly participant: Extract<ParticipantDirectoryRow["participant"], { readonly kind: "agent" }>;
};

const stateError = (state: string, nextCommand: string) =>
  new J5AgentToolStateError({ state, nextCommand });

const resolveCallerMembership = Effect.fn("j5.a2a.mcp.resolveCallerMembership")(function* (
  scope: McpInvocationScope,
) {
  const directory = yield* (yield* A2ASendService)
    .listParticipants(scope.threadId)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Caller thread ${scope.threadId} has no usable current Squadron membership: ${error instanceof Error ? error.message : String(error)}.`,
          "Call list_participants to inspect current Squadron membership before retrying.",
        ),
      ),
    );
  const memberships = directory.filter(
    (row): row is AgentDirectoryRow =>
      row.participant.kind === "agent" && row.participant.threadId === scope.threadId,
  );
  if (memberships.length === 0) {
    return yield* stateError(
      `Caller membership is missing for thread ${scope.threadId}.`,
      "Call list_participants to inspect current Squadron membership before retrying.",
    );
  }
  if (memberships.length !== 1) {
    return yield* stateError(
      `Caller membership for thread ${scope.threadId} is ambiguous across Squadrons ${memberships.map((row) => row.squadronId).join(", ")}.`,
      "Call list_participants to inspect current Squadron membership before retrying.",
    );
  }
  return memberships[0]!;
});

const preflightSpawnCaller = Effect.fn("j5.a2a.mcp.preflightSpawnCaller")(function* (
  scope: McpInvocationScope,
) {
  const homes = yield* A2AHomeRegistrar;
  const ledger = yield* A2ALedger;
  const home = yield* homes
    .getHomeForThread(scope.threadId)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Caller thread ${scope.threadId} has no usable immutable Squadron home: ${error instanceof Error ? error.message : String(error)}.`,
          "Call list_participants to inspect current membership, then ask the human to restore a sanctioned home before retrying spawn_agent.",
        ),
      ),
    );
  const squadron = yield* ledger
    .readSquadron(home.squadronId)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Caller thread ${scope.threadId} names home Squadron ${home.squadronId}, but that Squadron is unavailable: ${error instanceof Error ? error.message : String(error)}.`,
          "Ask the human to repair the caller's Squadron home before retrying spawn_agent.",
        ),
      ),
    );
  const membership = yield* resolveCallerMembership(scope);
  if (
    membership.squadronId !== home.squadronId ||
    membership.participantId !== home.participantId
  ) {
    return yield* stateError(
      `Caller thread ${scope.threadId} has immutable home ${home.squadronId}/${home.participantId}, but its current membership is ${membership.squadronId}/${membership.participantId}.`,
      "Call list_participants to inspect current membership, then ask the human to repair the mismatch before retrying spawn_agent.",
    );
  }
  return { ...membership, squadron };
});

const requireCallerSquadron = Effect.fn("j5.a2a.mcp.requireCallerSquadron")(function* (
  scope: McpInvocationScope,
  squadronId: SquadronId,
  command: "stop_agent" | "archive_agent",
) {
  const caller = yield* resolveCallerMembership(scope);
  if (caller.squadronId !== squadronId) {
    return yield* stateError(
      `Caller thread ${scope.threadId} is currently in Squadron ${caller.squadronId}, but ${command} targeted ${squadronId}.`,
      `Retry ${command} with squadron_id=${caller.squadronId}.`,
    );
  }
  return caller;
});

const readSquadronEvents = Effect.fn("j5.a2a.mcp.readSquadronEvents")(function* (
  squadronId: SquadronId,
) {
  const ledger = yield* A2ALedger;
  const events: Array<StoredCommEvent> = [];
  let cursor: LedgerCursor = { afterSeq: 0 };
  while (true) {
    const page = yield* ledger.readEvents({ squadronId, cursor, limit: 500 });
    events.push(...page.events);
    if (page.complete) return events;
    cursor = page.nextCursor;
  }
});

const resolveArchiveTarget = Effect.fn("j5.a2a.mcp.resolveArchiveTarget")(function* (
  squadronId: SquadronId,
  participantId: ParticipantId,
) {
  const placements = yield* ParticipantPlacementService;
  const activeMatches = (yield* placements.listParticipants(squadronId)).filter(
    (row) => row.participantId === participantId,
  );
  if (activeMatches.length > 1) {
    return yield* stateError(
      `Squadron ${squadronId} has ambiguous active participant ${participantId}.`,
      "Call list_participants and retry archive_agent with exactly one listed agent participant_id.",
    );
  }
  if (activeMatches.length === 1) {
    const target = activeMatches[0]!;
    if (target.participant.kind !== "agent" || target.threadId === null) {
      return yield* stateError(
        `Participant ${participantId} in Squadron ${squadronId} is not an agent with a thread and cannot be archived.`,
        "Call list_participants and retry archive_agent with an agent participant_id.",
      );
    }
    return {
      squadronId,
      participantId: target.participantId,
      threadId: target.threadId,
    } satisfies ArchiveAgentTarget;
  }

  // Retired participants are absent from the active membership projection. The
  // append-only ledger is the consume-only fallback for an idempotent replay.
  const historicalMatches = (yield* readSquadronEvents(squadronId)).flatMap((event) =>
    event.kind === "participant.joined" &&
    event.payload.participant.kind === "agent" &&
    event.payload.participant.id === participantId
      ? [event.payload.participant]
      : [],
  );
  if (historicalMatches.length !== 1) {
    return yield* stateError(
      `Squadron ${squadronId} has ${historicalMatches.length === 0 ? "no" : "ambiguous"} historical participant.joined agent identity for ${participantId}.`,
      "Call list_participants and retry archive_agent with exactly one active or historically joined agent participant_id.",
    );
  }
  const participant = historicalMatches[0]!;
  return {
    squadronId,
    participantId: participant.id,
    threadId: participant.threadId,
  } satisfies ArchiveAgentTarget;
});

const spawnTitle = (brief: string, title: string | undefined): string => {
  const value = title?.trim() || brief.trim();
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
};

const spawnFirstTurnText = (input: {
  readonly brief: string;
  readonly participantId: string;
  readonly squadronId: string;
  readonly squadronName: string;
}) =>
  `<j5_spawn_context>\nPlatform-provided identity facts:\nparticipant_id: ${input.participantId}\nsquadron_id: ${input.squadronId}\nsquadron_name: ${input.squadronName}\n</j5_spawn_context>\n\n<spawner_brief>\n${input.brief}\n</spawner_brief>`;

const selectSpawnModel = Effect.fn("j5.a2a.mcp.selectSpawnModel")(function* (
  scope: McpInvocationScope,
  input: { readonly provider: string; readonly model: string; readonly reasoning: string },
) {
  const capabilities = yield* (yield* OrchestratorMcpService)
    .capabilities(scope)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Provider capabilities are unavailable for spawn_agent: ${error.message}.`,
          "Call orchestrator_capabilities, choose an available provider, model, and reasoning option, then retry spawn_agent.",
        ),
      ),
    );
  const provider = capabilities.providers.find(
    (candidate) => candidate.providerInstanceId === input.provider,
  );
  if (provider === undefined) {
    return yield* stateError(
      `Provider ${input.provider} is not present in current orchestrator capabilities.`,
      "Call orchestrator_capabilities and retry spawn_agent with a listed provider.",
    );
  }
  if (provider.constraints.length > 0) {
    return yield* stateError(
      `Provider ${input.provider} is currently unavailable: ${provider.constraints.join(" ")}`,
      "Call orchestrator_capabilities and retry spawn_agent with an unconstrained provider.",
    );
  }
  const model = provider.models.find((candidate) => candidate.id === input.model);
  if (model === undefined) {
    return yield* stateError(
      `Model ${input.model} is not listed for provider ${input.provider}.`,
      "Call orchestrator_capabilities and retry spawn_agent with a model listed for that provider.",
    );
  }
  const reasoningDescriptor = model.options?.find(
    (descriptor) =>
      descriptor.type === "select" &&
      ["reasoningEffort", "effort", "variant"].includes(descriptor.id),
  );
  if (reasoningDescriptor === undefined || reasoningDescriptor.type !== "select") {
    return yield* stateError(
      `Model ${input.model} on provider ${input.provider} exposes no reasoning options; spawn_agent requires explicit reasoning selection.`,
      "Call orchestrator_capabilities and choose a model that exposes reasoning options before retrying spawn_agent.",
    );
  }
  if (!reasoningDescriptor.options.some((option) => option.id === input.reasoning)) {
    return yield* stateError(
      `Reasoning ${input.reasoning} is not listed for model ${input.model} on provider ${input.provider}.`,
      `Call orchestrator_capabilities and retry spawn_agent with one of: ${reasoningDescriptor.options.map((option) => option.id).join(", ")}.`,
    );
  }
  return {
    instanceId: provider.providerInstanceId,
    model: model.id,
    options: [{ id: reasoningDescriptor.id, value: input.reasoning }],
  } satisfies ModelSelection;
});

const handlers = {
  send_message: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const callerParticipantId = participantIdForThread(scope.threadId);
      if (input.to === callerParticipantId) {
        return yield* stateError(
          `send_message cannot target your own participant_id ${callerParticipantId}; self-messaging is not supported.`,
          "Call list_participants to find the intended recipient, or use schedule_task if you need a future trigger for yourself.",
        );
      }
      const crypto = yield* Crypto.Crypto;
      const service = yield* A2ASendService;
      const worker = yield* A2ADeliveryWorker;
      const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4);
      const result = yield* service.send({
        commandId: commandIdForRequest({
          toolName: "send_message",
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
  clear_own_ask: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* A2ASendService;
      const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      return yield* service.clearOwnAsk({
        commandId: commandIdForRequest({
          toolName: "clear_own_ask",
          providerSessionId: scope.providerSessionId,
          requestKey: input.client_request_id,
        }),
        senderThreadId: scope.threadId,
        exchangeId: input.exchange_id,
        acceptedAt,
      });
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
          const self =
            row.participant.kind === "agent" && row.participant.threadId === scope.threadId;
          return {
            squadron_id: row.squadronId,
            participant_id: row.participantId,
            participant:
              row.participant.kind === "agent"
                ? {
                    kind: row.participant.kind,
                    id: row.participant.id,
                    thread_id: row.participant.threadId,
                  }
                : row.participant,
            self,
            can_receive_message: !self && row.canReceiveMessage,
            can_open_exchange: !self && row.canOpenExchange,
            accepts_urgency: row.acceptsUrgency,
            thread_id: row.participant.kind === "agent" ? row.participant.threadId : null,
            provenance: projectProvenance(
              placement?.provenance ??
                (row.participant.kind === "human"
                  ? ({ kind: "not-applicable" } as const)
                  : ({ kind: "unrecorded" } as const)),
            ),
            placement_parent_id: placement?.placementParentId ?? null,
            display_name:
              row.participant.kind === "agent"
                ? (titleByThreadId.get(row.participant.threadId) ?? null)
                : null,
          };
        }),
      };
    }).pipe(Effect.mapError(failure)),
  spawn_agent: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const crypto = yield* Crypto.Crypto;
      const caller = yield* preflightSpawnCaller(scope);
      const modelSelection = yield* selectSpawnModel(scope, input);
      const threadManagement = yield* ThreadManagementService;
      const parent = yield* threadManagement
        .getThreadProjection(scope.threadId)
        .pipe(
          Effect.mapError((error) =>
            stateError(
              `Caller thread ${scope.threadId} cannot be read for spawn_agent: ${error.message}.`,
              "Read the caller thread state and retry spawn_agent after it is available.",
            ),
          ),
        );
      const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4);
      const stableInput = {
        providerSessionId: scope.providerSessionId,
        requestKey,
      };
      const threadId = spawnThreadId(stableInput);
      yield* threadManagement
        .dispatch({
          type: "thread.create",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: lifecycleCommandId({ ...stableInput, operation: "spawn-create" }),
          threadId,
          projectId: parent.thread.projectId,
          title: spawnTitle(input.brief, input.title),
          modelSelection,
          runtimeMode: parent.thread.runtimeMode,
          interactionMode: parent.thread.interactionMode,
          branch: parent.thread.branch,
          worktreePath: parent.thread.worktreePath,
        })
        .pipe(
          Effect.mapError((error) =>
            stateError(
              `Peer Agent thread ${threadId} could not be created: ${error.message}.`,
              error._tag === "OrchestratorCommandPreviouslyRejectedError"
                ? "Inspect the rejection, correct the request, and retry spawn_agent with a fresh client_request_id; the rejected key is permanently bound."
                : "Inspect the caller thread and provider state, then retry spawn_agent with the same client_request_id.",
            ),
          ),
        );
      const child = yield* threadManagement
        .getThreadProjection(threadId)
        .pipe(
          Effect.mapError((error) =>
            stateError(
              `Created Peer Agent thread ${threadId} is not readable: ${error.message}.`,
              "Retry spawn_agent with the same client_request_id so registration can continue safely.",
            ),
          ),
        );
      const facts = yield* (yield* SpawnCompositionService)
        .recordFacts({
          homeCommandId: spawnHomeCommandId(stableInput),
          placementCommandId: spawnPlacementCommandId(stableInput),
          squadronId: caller.squadronId,
          threadId,
          spawnedByParticipantId: caller.participantId,
          createdAt: DateTime.formatIso(child.thread.createdAt),
        })
        .pipe(
          Effect.mapError((error) =>
            stateError(
              `Peer Agent thread ${threadId} exists as a visible orphan without committed home/placement facts or a started brief: ${error.message}.`,
              "Retry spawn_agent with the same client_request_id only after repairing transient state; otherwise ask the human operator to retire or repair the orphan after A9 lifecycle support lands.",
            ),
          ),
        );
      if (
        facts.placement.provenance.kind !== "spawned-by" ||
        facts.placement.provenance.source !== "j5_spawn" ||
        facts.placement.placementParentId === null
      ) {
        return yield* stateError(
          `Peer Agent ${facts.home.participantId} committed placement facts that do not satisfy the J5 spawn contract.`,
          "Call list_participants to inspect committed placement truth and ask the human operator to repair the inconsistent record.",
        );
      }
      yield* threadManagement
        .dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: lifecycleCommandId({ ...stableInput, operation: "spawn-brief" }),
          threadId,
          messageId: spawnMessageId(stableInput),
          text: spawnFirstTurnText({
            brief: input.brief,
            participantId: facts.home.participantId,
            squadronId: facts.home.squadronId,
            squadronName: caller.squadron.name,
          }),
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(
          Effect.mapError((error) =>
            stateError(
              `Peer Agent ${facts.home.participantId} is registered and addressable, but its brief did not start: ${error.message}.`,
              "Retry spawn_agent with the same client_request_id to start the same brief safely.",
            ),
          ),
        );
      return {
        participant_id: facts.home.participantId,
        thread_id: threadId,
        squadron_id: facts.home.squadronId,
        placement: {
          placement_parent_id: facts.placement.placementParentId,
          provenance: {
            kind: "spawned-by" as const,
            spawned_by_participant_id: facts.placement.provenance.spawnedByParticipantId,
            source: facts.placement.provenance.source,
          },
        },
      };
    }).pipe(Effect.mapError(failure)),
  stop_agent: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const crypto = yield* Crypto.Crypto;
      yield* requireCallerSquadron(scope, input.squadron_id, "stop_agent");
      const placements = yield* ParticipantPlacementService;
      const matches = (yield* placements.listParticipants(input.squadron_id)).filter(
        (row) => row.participantId === input.participant_id,
      );
      if (matches.length !== 1) {
        return yield* stateError(
          `Squadron ${input.squadron_id} has ${matches.length === 0 ? "no" : "ambiguous"} participant ${input.participant_id}.`,
          "Call list_participants and retry stop_agent with exactly one listed agent participant_id.",
        );
      }
      const target = matches[0]!;
      if (target.participant.kind !== "agent" || target.threadId === null) {
        return yield* stateError(
          `Participant ${input.participant_id} in Squadron ${input.squadron_id} is not an agent with a thread and cannot be stopped.`,
          "Call list_participants and retry stop_agent with an agent participant_id.",
        );
      }
      const threadManagement = yield* ThreadManagementService;
      const targetProjection = yield* threadManagement
        .getThreadProjection(target.threadId)
        .pipe(
          Effect.mapError((error) =>
            stateError(
              `Peer Agent thread ${target.threadId} cannot be read for stop_agent: ${error.message}.`,
              "Call list_participants to confirm the target thread, then retry stop_agent.",
            ),
          ),
        );
      const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4);
      const result = yield* threadManagement
        .interruptThread({
          projectId: targetProjection.thread.projectId,
          commandId: lifecycleCommandId({
            providerSessionId: scope.providerSessionId,
            requestKey,
            operation: "stop-agent",
          }),
          threadId: target.threadId,
        })
        .pipe(
          Effect.mapError((error) =>
            stateError(
              `Peer Agent ${input.participant_id} on thread ${target.threadId} could not be stopped: ${error.message}.`,
              "Call list_participants to confirm the target, then retry stop_agent with the same client_request_id.",
            ),
          ),
        );
      return result.type === "interrupt_requested"
        ? ("interrupt_requested" as const)
        : ("already_idle" as const);
    }).pipe(Effect.mapError(failure)),
  archive_agent: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const crypto = yield* Crypto.Crypto;
      const caller = yield* requireCallerSquadron(scope, input.squadron_id, "archive_agent");
      if (input.participant_id === caller.participantId) {
        return yield* stateError(
          `archive_agent cannot archive the caller ${caller.participantId}.`,
          "The operation is refused.",
        );
      }
      const target = yield* resolveArchiveTarget(input.squadron_id, input.participant_id);
      const requestKey = input.client_request_id ?? (yield* crypto.randomUUIDv4);
      const archivedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      return yield* (yield* ArchiveAgentService).archive({
        providerSessionId: scope.providerSessionId,
        callerParticipantId: caller.participantId,
        target,
        clientRequestKey: requestKey,
        ...(input.confirmation_token === undefined
          ? {}
          : { confirmationToken: input.confirmation_token }),
        archivedAt,
        interruptCommandId: lifecycleCommandId({
          providerSessionId: scope.providerSessionId,
          requestKey,
          operation: "archive-agent-interrupt",
        }),
        archiveCommandId: lifecycleCommandId({
          providerSessionId: scope.providerSessionId,
          requestKey,
          operation: "archive-agent-thread",
        }),
      });
    }).pipe(Effect.mapError(archiveFailure)),
} satisfies Parameters<typeof J5Toolkit.toLayer>[0];

export const J5ToolkitHandlersLive = J5Toolkit.toLayer(handlers);
