import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../../config.ts";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorProjectionError,
  OrchestratorV2,
} from "../../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { AgentCrewInstanceService } from "../AgentCrewInstanceService.ts";
import {
  ArchiveCrewConfirmationRequiredError,
  ArchiveCrewService,
  type ArchiveCrewInput,
} from "../ArchiveCrewService.ts";
import { CrewStopService } from "../CrewStopService.ts";
import { CrewProposalService, type CrewProposalOutcome } from "../CrewProposalService.ts";
import type { CrewProposal, CrewProposalSeat } from "../AgentCrewProposalService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import {
  A2AHomeNotFoundError,
  A2AHomeRegistrar,
  participantIdForThread,
} from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { PeerDirectory, noneLayer as peerDirectoryNoneLayer } from "../PeerDirectory.ts";
import { ParticipantPlacementService, PlacementStorageError } from "../PlacementService.ts";
import { A2AHomeMembershipStateError, A2ASendService } from "../SendService.ts";
import { SpawnCompositionService } from "../SpawnCompositionService.ts";
import { SquadronJoinService } from "../SquadronJoinService.ts";
import { SquadronProjectReferences } from "../SquadronProjectReferences.ts";
import {
  type ClearOwnAskInput,
  ExchangeId,
  LedgerMessageId,
  ParticipantId,
  SquadronId,
  type ParticipantDirectoryRow,
  type SendMessageInput,
} from "../contracts.ts";
import { J5ToolkitHandlersLive } from "./handlers.ts";
import {
  J5ListParticipantsResult,
  J5Toolkit,
  type J5ArchiveCrewInput,
  type J5SendMessageInput,
  type J5ProposeCrewInput,
  type J5RequestCrewMemberInput,
  type J5SpawnAgentInput,
  type J5StopAgentInput,
} from "./tools.ts";

const decodeJ5ListParticipantsResult = Schema.decodeUnknownEffect(J5ListParticipantsResult);
const hasKey = (value: unknown, key: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return key in record || Object.values(record).some((item) => hasKey(item, key));
};
const forbiddenCamelCaseKeys = [
  "squadronId",
  "participantId",
  "threadId",
  "placementParentId",
  "spawnedByParticipantId",
  "sourceParticipantId",
  "canReceiveMessage",
  "canOpenExchange",
  "acceptsUrgency",
] as const;

const invocation = {
  environmentId: EnvironmentId.make("environment:j5:mcp-handler"),
  threadId: ThreadId.make("thread:j5:mcp-handler"),
  providerSessionId: "provider-session:j5:mcp-handler",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};

const projectId = ProjectId.make("project:j5:mcp-handler");
const createdAt = DateTime.makeUnsafe("2026-08-30T16:00:00.000Z");

const projection = (threadId: ThreadId): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: threadId,
      projectId,
      title: `Title ${threadId}`,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    },
  }) as unknown as OrchestrationV2ThreadProjection;

const unusedLifecycleDependencies = Layer.mergeAll(
  Layer.mock(A2AHomeRegistrar)({
    getHomeForThread: (threadId) => Effect.fail(new A2AHomeNotFoundError({ threadId })),
  }),
  Layer.mock(A2ALedger)({
    listSquadrons: () =>
      Effect.succeed([
        {
          id: SquadronId.make("squadron:j5:mcp-directory"),
          name: "Directory Squadron",
          createdAt: DateTime.formatIso(createdAt),
        },
      ]),
  }),
  Layer.mock(SpawnCompositionService)({}),
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(OrchestratorMcpService)({}),
  Layer.mock(AgentCrewInstanceService)({
    findMembership: () => Effect.succeed(null),
    listForCaptain: () => Effect.succeed([]),
  }),
  Layer.mock(ArchiveCrewService)({}),
  Layer.mock(CrewStopService)({}),
  Layer.mock(CrewProposalService)({}),
  peerDirectoryNoneLayer,
  Layer.mock(SquadronJoinService)({}),
  Layer.mock(SquadronProjectReferences)({}),
);

it.effect("namespaces mutating-tool idempotency and sender identity from authenticated scope", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(Object.keys(J5Toolkit.tools).sort(), [
      "archive_crew",
      "clear_own_ask",
      "join_squadron",
      "list_participants",
      "list_personas",
      "list_squadrons",
      "propose_crew",
      "request_crew_member",
      "send_message",
      "spawn_agent",
      "stop_agent",
      "stop_crew",
    ]);
    const sends = yield* Ref.make<ReadonlyArray<SendMessageInput>>([]);
    const clears = yield* Ref.make<ReadonlyArray<ClearOwnAskInput>>([]);
    const participantId = ParticipantId.make("agent:j5:mcp-handler");
    const callerParticipantId = participantIdForThread(invocation.threadId);
    const multiMembershipRecipientId = ParticipantId.make("agent:j5:mcp-multi-membership-target");
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: (input) =>
          input.to === multiMembershipRecipientId
            ? Effect.fail(
                new A2AHomeMembershipStateError({
                  threadId: invocation.threadId,
                  expectedSquadronId: "squadron:j5:mcp-home",
                  expectedParticipantId: callerParticipantId,
                  activeHomes: ["squadron:j5:mcp-home", "squadron:j5:mcp-extra"],
                }),
              )
            : Ref.update(sends, (items) => [...items, input]).pipe(
                Effect.as({
                  messageId: LedgerMessageId.make("message:j5:mcp-handler"),
                  exchangeId: null,
                  exchangeState: "none" as const,
                  joinedExistingExchange: false,
                  durableAtSeq: 1,
                }),
              ),
        sendAsMachine: () => Effect.die("unused"),
        clearOwnAsk: (input) =>
          Ref.update(clears, (items) => [...items, input]).pipe(
            Effect.as({
              exchangeId: input.exchangeId,
              closureKind: "sender-cleared" as const,
              closedAt: input.acceptedAt,
              withdrawalQueued: false,
            }),
          ),
        listParticipants: () =>
          Effect.die(new Error("send_message must not resolve the participant directory")),
      }),
    );
    const dependencies = Layer.mergeAll(
      sendService,
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(OrchestratorV2)({}),
      unusedLifecycleDependencies,
      Layer.mock(SquadronJoinService)({}),
      Layer.mock(SquadronProjectReferences)({}),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const call = (args: J5SendMessageInput) =>
        toolkit
          .handle("send_message", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );
      const callClear = (exchangeId: ExchangeId, clientRequestId: string) =>
        toolkit
          .handle("clear_own_ask", {
            exchange_id: exchangeId,
            client_request_id: clientRequestId,
          })
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );
      const sendArguments = {
        to: participantId,
        message: "Idempotent MCP send",
        client_request_id: "shared-logical-request-1",
      };
      yield* call(sendArguments);
      yield* call(sendArguments);
      yield* call({
        to: participantId,
        message: "Omitted optional MCP fields stay absent.",
      });
      yield* call({
        to: participantId,
        message: "Null optional MCP fields stay absent.",
        client_request_id: null,
        expect_reply: null,
        exchange_id: null,
        intent: null,
        urgency: null,
      });
      const selfSend = yield* call({
        to: callerParticipantId,
        message: "This must be rejected before storage.",
      });
      assert.isTrue(selfSend.isFailure);
      const selfSendMessage = (selfSend.result as unknown as { readonly message: string }).message;
      assert.include(selfSendMessage, callerParticipantId);
      assert.include(selfSendMessage, "list_participants");
      assert.include(selfSendMessage, "schedule_task");
      assert.notInclude(selfSendMessage, "Memo");
      const multiMembership = yield* call({
        to: multiMembershipRecipientId,
        message: "Preserve the sender membership error.",
      });
      assert.isTrue(multiMembership.isFailure);
      assert.deepInclude(multiMembership.result, {
        code: "A2AHomeMembershipStateError",
      });
      const multiMembershipMessage = (
        multiMembership.result as unknown as { readonly message: string }
      ).message;
      assert.include(multiMembershipMessage, "immutable home");
      assert.include(multiMembershipMessage, "active membership projection");
      const captured = yield* Ref.get(sends);
      assert.lengthOf(captured, 4);
      assert.equal(captured[0]?.commandId, captured[1]?.commandId);
      assert.equal(
        captured[0]?.commandId,
        "command:j5:a2a:mcp:provider-session%3Aj5%3Amcp-handler:send_message:shared-logical-request-1",
      );
      assert.equal(captured[0]?.senderThreadId, invocation.threadId);
      for (const input of captured.slice(2)) {
        assert.notProperty(input, "expectReply");
        assert.notProperty(input, "exchangeId");
        assert.notProperty(input, "intent");
        assert.notProperty(input, "urgency");
      }
      const exchangeId = ExchangeId.make("exchange:j5:mcp-handler:clear");
      yield* callClear(exchangeId, "shared-logical-request-1");
      yield* callClear(exchangeId, "shared-logical-request-1");
      const capturedClears = yield* Ref.get(clears);
      assert.lengthOf(capturedClears, 2);
      assert.equal(capturedClears[0]?.commandId, capturedClears[1]?.commandId);
      assert.equal(
        capturedClears[0]?.commandId,
        "command:j5:a2a:mcp:provider-session%3Aj5%3Amcp-handler:clear_own_ask:shared-logical-request-1",
      );
      assert.notEqual(captured[0]?.commandId, capturedClears[0]?.commandId);
      assert.equal(capturedClears[0]?.senderThreadId, invocation.threadId);
      assert.equal(capturedClears[0]?.exchangeId, exchangeId);
    }).pipe(Effect.provide(layer));
  }),
);
it.effect("keeps participant listing placement-read-only", () =>
  Effect.gen(function* () {
    const squadronId = SquadronId.make("squadron:j5:mcp-placement-handler");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-placement-caller");
    const forkedParticipantId = ParticipantId.make("agent:j5:mcp-placement-forked");
    const personParticipantId = ParticipantId.make("human:placement-person");
    const displayParentId = ParticipantId.make("agent:j5:mcp-display-parent");
    const forkSourceId = ParticipantId.make("agent:j5:mcp-fork-source");
    const placementWrites = yield* Ref.make(0);
    const callerRow = {
      squadronId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const forkedRow = {
      squadronId,
      participantId: forkedParticipantId,
      participant: {
        kind: "agent" as const,
        id: forkedParticipantId,
        threadId: ThreadId.make("thread:j5:mcp-placement-forked"),
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const humanRow = {
      squadronId,
      participantId: personParticipantId,
      participant: { kind: "human" as const, id: personParticipantId },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: true,
    } satisfies ParticipantDirectoryRow;
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("send_message is outside this placement-handler test"),
        clearOwnAsk: () => Effect.die("clear_own_ask is outside this placement-handler test"),
        sendAsMachine: () => Effect.die("unused"),
        listParticipants: () => Effect.succeed([callerRow, forkedRow, humanRow]),
      }),
    );
    const placementService = Layer.mock(ParticipantPlacementService)({
      recordCreation: () =>
        Ref.update(placementWrites, (count) => count + 1).pipe(
          Effect.andThen(Effect.die("the read handler must not repair placement")),
        ),
      listParticipants: () =>
        Effect.succeed([
          {
            squadronId,
            participantId: callerParticipantId,
            participant: callerRow.participant,
            threadId: invocation.threadId,
            provenance: {
              kind: "spawned-by" as const,
              spawnedByParticipantId: displayParentId,
              source: "j5_spawn" as const,
            },
            placementParentId: displayParentId,
          },
          {
            squadronId,
            participantId: forkedParticipantId,
            participant: forkedRow.participant,
            threadId: forkedRow.participant.threadId,
            provenance: {
              kind: "forked-from" as const,
              sourceParticipantId: forkSourceId,
              source: "upstream_lineage" as const,
            },
            placementParentId: callerParticipantId,
          },
        ]),
    });
    const dependencies = Layer.mergeAll(
      sendService,
      placementService,
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(OrchestratorV2)({
        getShellSnapshot: () =>
          Effect.fail(new OrchestratorProjectionError({ threadId: invocation.threadId })),
      }),
      unusedLifecycleDependencies,
      Layer.mock(SquadronJoinService)({}),
      Layer.mock(SquadronProjectReferences)({}),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const callList = () =>
        toolkit
          .handle("list_participants", {})
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );
      const listed = yield* callList();
      const listedRows = (yield* decodeJ5ListParticipantsResult(listed.encodedResult)).participants;
      assert.deepStrictEqual(listedRows[0]?.provenance, {
        kind: "spawned-by",
        spawned_by_participant_id: displayParentId,
        source: "j5_spawn",
      });
      assert.equal(listedRows[0]?.self, true);
      assert.equal(listedRows[0]?.can_receive_message, false);
      assert.equal(listedRows[0]?.can_open_exchange, false);
      assert.equal(listedRows[0]?.placement_parent_id, displayParentId);
      assert.deepStrictEqual(listedRows[1]?.provenance, {
        kind: "forked-from",
        source_participant_id: forkSourceId,
        source: "upstream_lineage",
      });
      assert.equal(listedRows[1]?.placement_parent_id, callerParticipantId);
      assert.equal(listedRows[1]?.self, false);
      assert.deepStrictEqual(listedRows[2]?.provenance, { kind: "not-applicable" });
      assert.equal(listedRows[2]?.placement_parent_id, null);
      assert.equal(listedRows[2]?.self, false);
      for (const camelCaseKey of forbiddenCamelCaseKeys) {
        assert.isFalse(hasKey(listed.encodedResult, camelCaseKey));
      }
      assert.equal(yield* Ref.get(placementWrites), 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("lists active and archived agent titles with one ambient shell snapshot", () =>
  Effect.gen(function* () {
    const squadronId = SquadronId.make("squadron:j5:mcp-directory");
    const activeThreadId = ThreadId.make("thread:j5:mcp-directory:active");
    const archivedThreadId = ThreadId.make("thread:j5:mcp-directory:archived");
    const missingThreadId = ThreadId.make("thread:j5:mcp-directory:missing");
    const activeParticipantId = ParticipantId.make("agent:j5:mcp-directory:active");
    const archivedParticipantId = ParticipantId.make("agent:j5:mcp-directory:archived");
    const missingParticipantId = ParticipantId.make("agent:j5:mcp-directory:missing");
    const humanParticipantId = ParticipantId.make("human:j5:mcp-directory");
    const row = (participant: ParticipantDirectoryRow["participant"]): ParticipantDirectoryRow => ({
      squadronId,
      participantId: participant.id,
      participant,
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: participant.kind === "human",
    });
    const rows = [
      row({ kind: "agent", id: activeParticipantId, threadId: activeThreadId }),
      row({ kind: "agent", id: archivedParticipantId, threadId: archivedThreadId }),
      row({ kind: "agent", id: missingParticipantId, threadId: missingThreadId }),
      row({ kind: "human", id: humanParticipantId }),
    ];
    const now = DateTime.makeUnsafe("2026-08-29T12:00:00.000Z");
    const modelSelection = {
      instanceId: invocation.providerInstanceId,
      model: "gpt-5.6-sol",
    } satisfies ModelSelection;
    const projectId = ProjectId.make("project:j5:mcp-directory");
    const shell = (input: {
      readonly id: ThreadId;
      readonly title: string;
      readonly archivedAt: DateTime.Utc | null;
    }): OrchestrationV2ThreadShell => ({
      createdBy: "agent",
      creationSource: "mcp",
      id: input.id,
      projectId,
      title: input.title,
      providerInstanceId: invocation.providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.id,
      },
      forkedFrom: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: input.archivedAt,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    });
    const activeShell = shell({
      id: activeThreadId,
      title: "Release reviewer",
      archivedAt: null,
    });
    const archivedShell = shell({
      id: archivedThreadId,
      title: "Archived researcher",
      archivedAt: now,
    });
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("unused"),
        clearOwnAsk: () => Effect.die("unused"),
        sendAsMachine: () => Effect.die("unused"),
        listParticipants: () => Effect.succeed(rows),
      }),
    );
    const shellSnapshotCalls = yield* Ref.make(0);
    const orchestrator = Layer.mock(OrchestratorV2)({
      getShellSnapshot: () =>
        Ref.update(shellSnapshotCalls, (calls) => calls + 1).pipe(
          Effect.as({
            schemaVersion: 2,
            snapshotSequence: 1,
            threads: [activeShell],
            archivedThreads: [archivedShell],
          }),
        ),
    });
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          sendService,
          orchestrator,
          Layer.mock(ParticipantPlacementService)({
            listParticipants: () => Effect.succeed([]),
          }),
          Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
          unusedLifecycleDependencies,
          Layer.mock(SquadronJoinService)({}),
          Layer.mock(SquadronProjectReferences)({}),
          NodeServices.layer,
        ),
      ),
    );

    const result = yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      return yield* toolkit
        .handle("list_participants", {})
        .pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(McpInvocationContext, invocation),
        );
    }).pipe(Effect.provide(layer));
    const directory = yield* decodeJ5ListParticipantsResult(result.encodedResult);
    assert.equal(yield* Ref.get(shellSnapshotCalls), 1);

    assert.deepStrictEqual(directory.participants, [
      {
        squadron_id: squadronId,
        squadron_name: "Directory Squadron",
        participant_id: activeParticipantId,
        participant: { kind: "agent", id: activeParticipantId, thread_id: activeThreadId },
        self: false,
        archived: false,
        can_receive_message: true,
        can_open_exchange: true,
        accepts_urgency: false,
        thread_id: activeThreadId,
        provenance: { kind: "unrecorded" },
        placement_parent_id: null,
        display_name: "Release reviewer",
      },
      {
        squadron_id: squadronId,
        squadron_name: "Directory Squadron",
        participant_id: archivedParticipantId,
        participant: { kind: "agent", id: archivedParticipantId, thread_id: archivedThreadId },
        self: false,
        archived: false,
        can_receive_message: true,
        can_open_exchange: true,
        accepts_urgency: false,
        thread_id: archivedThreadId,
        provenance: { kind: "unrecorded" },
        placement_parent_id: null,
        display_name: "Archived researcher",
      },
      {
        squadron_id: squadronId,
        squadron_name: "Directory Squadron",
        participant_id: missingParticipantId,
        participant: { kind: "agent", id: missingParticipantId, thread_id: missingThreadId },
        self: false,
        archived: false,
        can_receive_message: true,
        can_open_exchange: true,
        accepts_urgency: false,
        thread_id: missingThreadId,
        provenance: { kind: "unrecorded" },
        placement_parent_id: null,
        display_name: null,
      },
      {
        squadron_id: squadronId,
        squadron_name: "Directory Squadron",
        participant_id: humanParticipantId,
        participant: { kind: "human", id: humanParticipantId },
        self: false,
        archived: false,
        can_receive_message: true,
        can_open_exchange: true,
        accepts_urgency: true,
        thread_id: null,
        provenance: { kind: "not-applicable" },
        placement_parent_id: null,
        display_name: null,
      },
    ]);
    for (const camelCaseKey of forbiddenCamelCaseKeys) {
      assert.isFalse(hasKey(result.encodedResult, camelCaseKey));
    }
  }),
);

it.effect("returns null display names when the ambient shell snapshot fails", () =>
  Effect.gen(function* () {
    const squadronId = SquadronId.make("squadron:j5:mcp-directory:snapshot-failure");
    const agentParticipantId = ParticipantId.make("agent:j5:mcp-directory:snapshot-failure");
    const humanParticipantId = ParticipantId.make("human:j5:mcp-directory:snapshot-failure");
    const rows: ReadonlyArray<ParticipantDirectoryRow> = [
      {
        squadronId,
        participantId: agentParticipantId,
        participant: {
          kind: "agent",
          id: agentParticipantId,
          threadId: ThreadId.make("thread:j5:mcp-directory:snapshot-failure"),
        },
        archived: false,
        canReceiveMessage: true,
        canOpenExchange: true,
        acceptsUrgency: false,
      },
      {
        squadronId,
        participantId: humanParticipantId,
        participant: { kind: "human", id: humanParticipantId },
        archived: false,
        canReceiveMessage: true,
        canOpenExchange: true,
        acceptsUrgency: true,
      },
    ];
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("unused"),
        clearOwnAsk: () => Effect.die("unused"),
        sendAsMachine: () => Effect.die("unused"),
        listParticipants: () => Effect.succeed(rows),
      }),
    );
    const shellSnapshotCalls = yield* Ref.make(0);
    const orchestrator = Layer.mock(OrchestratorV2)({
      getShellSnapshot: () =>
        Ref.update(shellSnapshotCalls, (calls) => calls + 1).pipe(
          Effect.andThen(
            Effect.fail(new OrchestratorProjectionError({ threadId: invocation.threadId })),
          ),
        ),
    });
    const layer = J5ToolkitHandlersLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          sendService,
          orchestrator,
          Layer.mock(ParticipantPlacementService)({
            listParticipants: () => Effect.succeed([]),
          }),
          Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
          unusedLifecycleDependencies,
          Layer.mock(SquadronJoinService)({}),
          Layer.mock(SquadronProjectReferences)({}),
          NodeServices.layer,
        ),
      ),
    );

    const result = yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      return yield* toolkit
        .handle("list_participants", {})
        .pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(McpInvocationContext, invocation),
        );
    }).pipe(Effect.provide(layer));
    const directory = yield* decodeJ5ListParticipantsResult(result.encodedResult);

    assert.equal(yield* Ref.get(shellSnapshotCalls), 1);
    assert.deepStrictEqual(
      directory.participants.map(({ display_name }) => display_name),
      [null, null],
    );
  }),
);

it.effect("preflights home before creation and records facts before the one stable brief", () =>
  Effect.gen(function* () {
    const squadronId = SquadronId.make("squadron:j5:mcp-spawn");
    const squadronName = "Release proof Squadron";
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-spawn-caller");
    const childParticipantId = ParticipantId.make("agent:j5:mcp-spawn-child");
    const failFacts = yield* Ref.make(false);
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
    const facts = yield* Ref.make<
      ReadonlyArray<{
        readonly homeCommandId: string;
        readonly placementCommandId: string;
        readonly spawnedByParticipantId: ParticipantId;
        readonly threadId: ThreadId;
      }>
    >([]);
    const callerRow = {
      squadronId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("send_message is outside this spawn test"),
        clearOwnAsk: () => Effect.die("clear_own_ask is outside this spawn test"),
        sendAsMachine: () => Effect.die("unused"),
        listParticipants: () => Effect.succeed([callerRow]),
      }),
    );
    const homeService = Layer.mock(A2AHomeRegistrar)({
      getHomeForThread: () => Effect.succeed({ squadronId, participantId: callerParticipantId }),
    });
    const ledger = Layer.mock(A2ALedger)({
      readSquadron: () =>
        Effect.succeed({
          id: squadronId,
          name: squadronName,
          createdAt: DateTime.formatIso(createdAt),
        }),
    });
    const composition = Layer.mock(SpawnCompositionService)({
      recordFacts: (input) =>
        Ref.get(failFacts).pipe(
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(
                  new PlacementStorageError({
                    operation: "record spawn facts",
                    cause: new Error("injected placement failure"),
                  }),
                )
              : Effect.all(
                  [
                    Ref.update(order, (items) => [...items, "facts"]),
                    Ref.update(facts, (items) => [
                      ...items,
                      {
                        homeCommandId: input.homeCommandId,
                        placementCommandId: input.placementCommandId,
                        spawnedByParticipantId:
                          input.provenance.kind === "spawned-by"
                            ? input.provenance.spawnedByParticipantId
                            : callerParticipantId,
                        threadId: input.threadId,
                      },
                    ]),
                  ],
                  { discard: true },
                ).pipe(
                  Effect.as({
                    home: { squadronId, participantId: childParticipantId },
                    placement: {
                      squadronId,
                      participantId: childParticipantId,
                      provenance: {
                        kind: "spawned-by" as const,
                        spawnedByParticipantId: callerParticipantId,
                        source: "j5_spawn" as const,
                      },
                      placementParentId: callerParticipantId,
                      createdEventSeq: 1,
                      updatedEventSeq: 1,
                    },
                  }),
                ),
          ),
        ),
    });
    const threadManagement = Layer.mock(ThreadManagementService)({
      getThreadProjection: (threadId) => Effect.succeed(projection(threadId)),
      dispatch: (command) =>
        command.type === "thread.create" && String(command.commandId).includes("spawn-rejected")
          ? Effect.fail(
              new OrchestratorCommandPreviouslyRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                detail: "injected rejected creation",
              }),
            )
          : Effect.all(
              [
                Ref.update(commands, (items) => [...items, command]),
                Ref.update(order, (items) => [...items, command.type]),
              ],
              { discard: true },
            ).pipe(Effect.as({ events: [], effects: [] } as never)),
    });
    const orchestrator = Layer.mock(OrchestratorMcpService)({
      capabilities: () =>
        Effect.succeed({
          parentThreadId: invocation.threadId,
          inheritedProviderInstanceId: invocation.providerInstanceId,
          inheritedModel: "gpt-5.6-sol",
          runtimeMode: "full-access",
          interactionMode: "default",
          providers: [
            {
              providerInstanceId: ProviderInstanceId.make("codex-luna"),
              driverKind: ProviderDriverKind.make("codex"),
              displayName: "Codex Luna",
              models: [
                {
                  id: "gpt-5.6-luna",
                  label: "GPT-5.6 Luna",
                  options: [
                    {
                      id: "reasoningEffort",
                      label: "Reasoning",
                      type: "select" as const,
                      options: [
                        { id: "medium", label: "Medium" },
                        { id: "high", label: "High" },
                      ],
                    },
                  ],
                },
                {
                  id: "grok-custom-optionless",
                  label: "Grok Custom Optionless",
                },
              ],
              canRunChildTask: true,
              canRunCrossProviderChildTask: true,
              constraints: [],
            },
          ],
          features: {
            appOwnedSubagents: true,
            asyncPolling: true,
            cancellation: true,
            batchThreadCreation: true,
            threadManagement: true,
            incrementalThreadRead: true,
            scheduledTasks: true,
            maxBatchThreads: 8,
          },
        }),
    });
    const dependencies = Layer.mergeAll(
      sendService,
      homeService,
      ledger,
      composition,
      threadManagement,
      orchestrator,
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(AgentCrewInstanceService)({ findMembership: () => Effect.succeed(null) }),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      Layer.mock(CrewProposalService)({}),

      Layer.mock(SquadronJoinService)({}),
      Layer.mock(SquadronProjectReferences)({}),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const call = (args: J5SpawnAgentInput) =>
        toolkit
          .handle("spawn_agent", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );
      const args = {
        brief: "Prove the post-#18 verb slice and report the result.",
        provider: ProviderInstanceId.make("codex-luna"),
        model: "gpt-5.6-luna",
        reasoning: "high",
        client_request_id: "spawn-peer-1",
      } satisfies J5SpawnAgentInput;
      const first = yield* call(args);
      const replay = yield* call(args);
      assert.isFalse(first.isFailure);
      assert.deepStrictEqual(replay.result, first.result);
      assert.deepStrictEqual(first.result, {
        participant_id: childParticipantId,
        thread_id: (first.result as { readonly thread_id: ThreadId }).thread_id,
        squadron_id: squadronId,
        placement: {
          placement_parent_id: callerParticipantId,
          provenance: {
            kind: "spawned-by",
            spawned_by_participant_id: callerParticipantId,
            source: "j5_spawn",
          },
        },
      });
      assert.deepStrictEqual(yield* Ref.get(order), [
        "thread.create",
        "facts",
        "message.dispatch",
        "thread.create",
        "facts",
        "message.dispatch",
      ]);
      const capturedCommands = yield* Ref.get(commands);
      assert.equal(capturedCommands[0]?.commandId, capturedCommands[2]?.commandId);
      assert.equal(capturedCommands[1]?.commandId, capturedCommands[3]?.commandId);
      const capturedFacts = yield* Ref.get(facts);
      assert.deepStrictEqual(capturedFacts[1], capturedFacts[0]);
      const create = capturedCommands[0];
      assert.equal(create?.type, "thread.create");
      if (create?.type === "thread.create") {
        assert.notProperty(create, "parentThreadId");
        assert.deepStrictEqual(create.modelSelection, {
          instanceId: ProviderInstanceId.make("codex-luna"),
          model: "gpt-5.6-luna",
          options: [{ id: "reasoningEffort", value: "high" }],
        });
      }
      const firstTurn = capturedCommands[1];
      assert.equal(firstTurn?.type, "message.dispatch");
      if (firstTurn?.type === "message.dispatch") {
        assert.equal(
          firstTurn.text,
          `<j5_spawn_context>\nPlatform-provided identity facts:\nparticipant_id: ${childParticipantId}\nsquadron_id: ${squadronId}\nsquadron_name: ${squadronName}\nspawned_by: ${callerParticipantId}\nspawner_thread_id: ${invocation.threadId}\n</j5_spawn_context>\n\n<spawner_brief>\n${args.brief}\n</spawner_brief>`,
        );
      }
      const replayTurn = capturedCommands[3];
      assert.equal(replayTurn?.type, "message.dispatch");
      if (firstTurn?.type === "message.dispatch" && replayTurn?.type === "message.dispatch") {
        assert.equal(replayTurn.commandId, firstTurn.commandId);
        assert.equal(replayTurn.messageId, firstTurn.messageId);
        assert.equal(replayTurn.text, firstTurn.text);
      }
      assert.equal(capturedFacts[0]?.spawnedByParticipantId, callerParticipantId);
      const invalidReasoning = yield* call({
        ...args,
        reasoning: "ultra",
        client_request_id: "spawn-invalid-reasoning",
      });
      assert.isTrue(invalidReasoning.isFailure);
      assert.include(
        (invalidReasoning.result as unknown as { readonly message: string }).message,
        "Reasoning ultra is not listed",
      );
      assert.lengthOf(yield* Ref.get(commands), 4);

      const optionless = yield* call({
        ...args,
        model: "grok-custom-optionless",
        client_request_id: "spawn-optionless-model",
      });
      assert.isTrue(optionless.isFailure);
      assert.include(
        (optionless.result as unknown as { readonly message: string }).message,
        "Model grok-custom-optionless on provider codex-luna exposes no reasoning options; spawn_agent requires explicit reasoning selection",
      );
      assert.lengthOf(yield* Ref.get(commands), 4);

      const rejected = yield* call({
        ...args,
        client_request_id: "spawn-rejected-create",
      });
      assert.isTrue(rejected.isFailure);
      assert.include(
        (rejected.result as unknown as { readonly message: string }).message,
        "fresh client_request_id; the rejected key is permanently bound",
      );
      assert.lengthOf(yield* Ref.get(commands), 4);

      yield* Ref.set(failFacts, true);
      const orphaned = yield* call({
        ...args,
        client_request_id: "spawn-facts-fail",
      });
      assert.isTrue(orphaned.isFailure);
      const orphanedMessage = (orphaned.result as unknown as { readonly message: string }).message;
      assert.include(orphanedMessage, "visible orphan without committed home/placement facts");
      assert.include(orphanedMessage, "after A9 lifecycle support lands");
      assert.lengthOf(yield* Ref.get(commands), 5);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses spawn before thread creation when the caller has no home", () =>
  Effect.gen(function* () {
    const dispatches = yield* Ref.make(0);
    const dependencies = Layer.mergeAll(
      Layer.mock(A2AHomeRegistrar)({
        getHomeForThread: (threadId) => Effect.fail(new A2AHomeNotFoundError({ threadId })),
      }),
      Layer.mock(A2ALedger)({}),
      Layer.mock(A2ASendService)({}),
      Layer.mock(SpawnCompositionService)({}),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(OrchestratorMcpService)({}),
      peerDirectoryNoneLayer,
      Layer.mock(ThreadManagementService)({
        dispatch: () => Ref.update(dispatches, (count) => count + 1).pipe(Effect.as({} as never)),
      }),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(AgentCrewInstanceService)({ findMembership: () => Effect.succeed(null) }),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      Layer.mock(CrewProposalService)({}),

      Layer.mock(SquadronJoinService)({}),
      Layer.mock(SquadronProjectReferences)({}),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const result = yield* toolkit
        .handle("spawn_agent", {
          brief: "This must never start.",
          provider: ProviderInstanceId.make("codex-luna"),
          model: "gpt-5.6-luna",
          reasoning: "high",
        })
        .pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(McpInvocationContext, invocation),
        );
      assert.isTrue(result.isFailure);
      assert.include(
        (result.result as unknown as { readonly message: string }).message,
        "no usable immutable Squadron home",
      );
      assert.equal(yield* Ref.get(dispatches), 0);
    }).pipe(Effect.provide(layer));
  }),
);

const personaProvider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ readonly slug: string; readonly options: ReadonlyArray<string> }>,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-09T00:00:00Z",
  availability: "available",
  slashCommands: [],
  skills: [],
  models: models.map((model) => ({
    slug: model.slug,
    name: model.slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: driver === "codex" ? "reasoningEffort" : "effort",
          label: "Reasoning",
          type: "select",
          options: model.options.map((id) => ({ id, label: id })),
        },
      ],
    },
  })),
});

const personaCapabilityProvider = (provider: ServerProvider) => ({
  providerInstanceId: provider.instanceId,
  driverKind: provider.driver,
  displayName: String(provider.instanceId),
  models: provider.models.map((model) => ({
    id: model.slug,
    label: model.name,
    options: model.capabilities?.optionDescriptors?.map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      type: "select" as const,
      options: descriptor.type === "select" ? descriptor.options : [],
    })),
  })),
  canRunChildTask: true,
  canRunCrossProviderChildTask: true,
  constraints: [],
});

it.effect("spawns a saved agent as a Peer Agent only within its declared routes", () =>
  Effect.gen(function* () {
    const squadronId = SquadronId.make("squadron:j5:mcp-spawn-persona");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-spawn-persona-caller");
    const childParticipantId = ParticipantId.make("agent:j5:mcp-spawn-persona-child");
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
    const codex = personaProvider("codex", "codex", [
      { slug: "gpt-5.6-terra", options: ["medium", "high"] },
      { slug: "gpt-5.6-sol", options: ["high"] },
    ]);
    const claude = personaProvider("claudeAgent", "claudeAgent", [
      { slug: "claude-opus-5", options: ["high"] },
    ]);
    const callerRow = {
      squadronId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const dependencies = Layer.mergeAll(
      Layer.mock(A2ASendService)({ listParticipants: () => Effect.succeed([callerRow]) }),
      Layer.mock(A2AHomeRegistrar)({
        getHomeForThread: () => Effect.succeed({ squadronId, participantId: callerParticipantId }),
      }),
      Layer.mock(A2ALedger)({
        readSquadron: () =>
          Effect.succeed({
            id: squadronId,
            name: "Persona",
            createdAt: DateTime.formatIso(createdAt),
          }),
      }),
      Layer.mock(SpawnCompositionService)({
        recordFacts: (input) =>
          Effect.succeed({
            home: { squadronId, participantId: childParticipantId },
            placement: {
              squadronId,
              participantId: childParticipantId,
              provenance: input.provenance,
              placementParentId:
                input.provenance.kind === "spawned-by"
                  ? input.provenance.spawnedByParticipantId
                  : null,
              createdEventSeq: 1,
              updatedEventSeq: 1,
            },
          }),
      }),
      Layer.mock(ThreadManagementService)({
        getThreadProjection: (threadId) => Effect.succeed(projection(threadId)),
        dispatch: (command) =>
          Ref.update(commands, (items) => [...items, command]).pipe(
            Effect.as({ events: [], effects: [] } as never),
          ),
      }),
      Layer.mock(OrchestratorMcpService)({
        capabilities: () =>
          Effect.succeed({
            parentThreadId: invocation.threadId,
            inheritedProviderInstanceId: invocation.providerInstanceId,
            inheritedModel: "gpt-5.6-sol",
            runtimeMode: "full-access",
            interactionMode: "default",
            providers: [personaCapabilityProvider(codex), personaCapabilityProvider(claude)],
            features: {
              appOwnedSubagents: true,
              asyncPolling: true,
              cancellation: true,
              batchThreadCreation: true,
              threadManagement: true,
              incrementalThreadRead: true,
              scheduledTasks: true,
              maxBatchThreads: 8,
            },
          }),
      }),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codex, claude]) }),
      Layer.mock(AgentCrewInstanceService)({ findMembership: () => Effect.succeed(null) }),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      Layer.mock(CrewProposalService)({}),

      ServerConfig.layerTest(process.cwd(), { prefix: "j5-mcp-spawn-persona-" }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const call = (args: J5SpawnAgentInput) =>
        toolkit
          .handle("spawn_agent", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );
      const failureMessage = (response: { readonly result: unknown }) =>
        (response.result as { readonly message: string }).message;
      const createdThreads = () =>
        Ref.get(commands).pipe(
          Effect.map((items) =>
            items.flatMap((command) => (command.type === "thread.create" ? [command] : [])),
          ),
        );
      const briefs = () =>
        Ref.get(commands).pipe(
          Effect.map((items) =>
            items.flatMap((command) => (command.type === "message.dispatch" ? [command] : [])),
          ),
        );
      const scout = {
        brief: "Collect evidence about the auth flow and report back.",
        persona: "scout",
        provider: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-terra",
        reasoning: "high",
        client_request_id: "spawn-persona-primary",
      } satisfies J5SpawnAgentInput;

      const primary = yield* call(scout);
      assert.isFalse(primary.isFailure, failureMessage(primary));
      const created = yield* createdThreads();
      assert.lengthOf(created, 1);
      const assignment = created[0]!.agentPersonaAssignment;
      assert.isDefined(assignment);
      assert.equal(assignment?.personaId, "scout");
      assert.equal(assignment?.displayName, "Scout");
      assert.equal(assignment?.resolvedRoute, "primary");
      assert.equal(assignment?.resolvedDriver, "codex");
      assert.equal(assignment?.authorityPolicy, "read-only");
      assert.match(assignment?.definitionDigest ?? "", /^[a-f0-9]{64}$/);
      const expectedSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-terra",
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      assert.deepStrictEqual(created[0]!.modelSelection, expectedSelection);
      assert.deepStrictEqual(assignment?.resolvedModelSelection, expectedSelection);
      assert.equal(created[0]!.runtimeMode, "approval-required");
      assert.deepStrictEqual((yield* briefs())[0]!.modelSelection, expectedSelection);

      const fallback = yield* call({
        ...scout,
        provider: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5",
        client_request_id: "spawn-persona-fallback",
      });
      assert.isFalse(fallback.isFailure, failureMessage(fallback));
      const fallbackCreate = (yield* createdThreads())[1]!;
      assert.equal(fallbackCreate.agentPersonaAssignment?.resolvedRoute, "fallback");
      assert.equal(fallbackCreate.agentPersonaAssignment?.resolvedDriver, "claudeAgent");
      assert.deepStrictEqual(fallbackCreate.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5",
        options: [{ id: "effort", value: "high" }],
      });

      const plain = yield* call({
        brief: "No saved agent here.",
        provider: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
        reasoning: "high",
        client_request_id: "spawn-persona-plain",
      });
      assert.isFalse(plain.isFailure, failureMessage(plain));
      const plainCreate = (yield* createdThreads())[2]!;
      assert.notProperty(plainCreate, "agentPersonaAssignment");
      assert.equal(plainCreate.runtimeMode, "full-access");

      const commandCount = (yield* Ref.get(commands)).length;
      const outOfRoute = yield* call({
        ...scout,
        reasoning: "medium",
        client_request_id: "spawn-persona-out-of-route",
      });
      assert.isTrue(outOfRoute.isFailure);
      assert.include(failureMessage(outOfRoute), "Agent scout allows only");
      assert.include(failureMessage(outOfRoute), "outside its declared routes");
      assert.include(failureMessage(outOfRoute), "or omit persona");

      const unenforceable = yield* call({
        ...scout,
        persona: "builder",
        provider: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5",
        client_request_id: "spawn-persona-unenforceable",
      });
      assert.isTrue(unenforceable.isFailure);
      assert.include(
        failureMessage(unenforceable),
        "cannot enforce its workspace-write permissions on claudeAgent",
      );

      const unknown = yield* call({
        ...scout,
        persona: "nobody",
        client_request_id: "spawn-persona-unknown",
      });
      assert.isTrue(unknown.isFailure);
      assert.include(failureMessage(unknown), "Unknown agent nobody");
      assert.lengthOf(yield* Ref.get(commands), commandCount);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("archives a crew only as a unit through its captain with one confirmation", () =>
  Effect.gen(function* () {
    const squadronId = SquadronId.make("squadron:j5:mcp-archive-crew");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-archive-crew-captain");
    const memberParticipantId = ParticipantId.make("agent:j5:mcp-archive-crew-member");
    const archiveCalls = yield* Ref.make<ReadonlyArray<ArchiveCrewInput>>([]);
    const callerRow = {
      squadronId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const memberRow = {
      squadronId,
      participantId: memberParticipantId,
      participant: {
        kind: "agent" as const,
        id: memberParticipantId,
        threadId: ThreadId.make("thread:j5:mcp-archive-crew-member"),
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const facts = {
      members: [
        {
          seatName: "builder",
          participantId: memberParticipantId,
          threadId: memberRow.participant.threadId,
          alreadyArchived: false,
          facts: {
            openExchanges: [
              {
                exchangeId: ExchangeId.make("exchange:j5:mcp-archive-crew"),
                direction: "inbound" as const,
                replyObligation: "participant-owes-reply" as const,
                counterpartyId: callerParticipantId,
                intent: "Review the login fix",
                urgency: null,
                openedAt: DateTime.formatIso(createdAt),
              },
            ],
            runningTurn: null,
          },
        },
      ],
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(A2ASendService)({
        listParticipants: () => Effect.succeed([callerRow, memberRow]),
      }),
      Layer.mock(A2AHomeRegistrar)({}),
      Layer.mock(A2ALedger)({}),
      Layer.mock(SpawnCompositionService)({}),
      Layer.mock(ThreadManagementService)({}),
      Layer.mock(OrchestratorMcpService)({}),
      Layer.mock(ProviderRegistry)({}),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(AgentCrewInstanceService)({}),
      Layer.mock(CrewProposalService)({}),
      Layer.mock(ArchiveCrewService)({
        archive: (input) =>
          Ref.update(archiveCalls, (items) => [...items, input]).pipe(
            Effect.andThen(
              input.confirmationToken === undefined
                ? Effect.fail(
                    new ArchiveCrewConfirmationRequiredError({
                      facts,
                      confirmationToken: "crew-token",
                    }),
                  )
                : Effect.succeed({
                    status: "archived" as const,
                    members: [
                      {
                        seatName: "builder",
                        participantId: memberParticipantId,
                        result: "archived" as const,
                      },
                    ],
                  }),
            ),
          ),
      }),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(CrewStopService)({}),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const message = (response: { readonly result: unknown }) =>
        (response.result as { readonly message: string }).message;
      const run = (args: J5ArchiveCrewInput) =>
        toolkit
          .handle("archive_crew", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );
      const refused = yield* run({
        squadron_id: squadronId,
        crew_instance_id: "crew:j5:test",
        client_request_id: "archive-crew-1",
      });
      assert.isTrue(refused.isFailure);
      const refusal = refused.result as {
        readonly code: string;
        readonly confirmation_token: string;
        readonly members: ReadonlyArray<{
          readonly seat: string;
          readonly participant_id: string;
          readonly already_archived: boolean;
          readonly open_exchanges: ReadonlyArray<{ readonly exchange_id: string }>;
          readonly running_turn: unknown;
        }>;
      };
      assert.equal(refusal.code, "ArchiveCrewConfirmationRequiredError");
      assert.equal(refusal.confirmation_token, "crew-token");
      assert.deepStrictEqual(
        refusal.members.map((member) => [
          member.seat,
          member.participant_id,
          member.already_archived,
          member.open_exchanges.map(({ exchange_id }) => exchange_id),
          member.running_turn,
        ]),
        [["builder", memberParticipantId, false, ["exchange:j5:mcp-archive-crew"], null]],
      );
      assert.include(message(refused), "check with the user");

      const confirmed = yield* run({
        squadron_id: squadronId,
        crew_instance_id: "crew:j5:test",
        client_request_id: "archive-crew-1",
        confirmation_token: "crew-token",
      });
      assert.isFalse(confirmed.isFailure, message(confirmed));
      assert.deepStrictEqual(confirmed.result, {
        status: "archived",
        crew_instance_id: "crew:j5:test",
        members: [{ seat: "builder", participant_id: memberParticipantId, result: "archived" }],
      });
      const calls = yield* Ref.get(archiveCalls);
      assert.lengthOf(calls, 2);
      assert.equal(calls[1]?.callerParticipantId, callerParticipantId);
      assert.equal(calls[1]?.clientRequestKey, "archive-crew-1");
      const ids = calls[1]!.commandIds("builder");
      assert.include(ids.archiveCommandId, "archive-crew-thread");
      assert.include(ids.archiveCommandId, encodeURIComponent("archive-crew-1/seat/builder"));
      assert.notEqual(ids.archiveCommandId, calls[1]!.commandIds("critic").archiveCommandId);

      const wrongSquadron = yield* run({
        squadron_id: SquadronId.make("squadron:j5:other"),
        crew_instance_id: "crew:j5:test",
      });
      assert.isTrue(wrongSquadron.isFailure);
      assert.include(message(wrongSquadron), "archive_crew targeted squadron:j5:other");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("lists saved agents with purpose, policy, availability, and route", () =>
  Effect.gen(function* () {
    const codex = personaProvider("codex", "codex", [
      { slug: "gpt-5.6-terra", options: ["high"] },
      { slug: "gpt-5.6-sol", options: ["high"] },
    ]);
    const dependencies = Layer.mergeAll(
      Layer.mock(A2ASendService)({}),
      Layer.mock(A2AHomeRegistrar)({}),
      Layer.mock(A2ALedger)({}),
      Layer.mock(SpawnCompositionService)({}),
      Layer.mock(ThreadManagementService)({}),
      Layer.mock(OrchestratorMcpService)({}),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codex]) }),
      Layer.mock(AgentCrewInstanceService)({ findMembership: () => Effect.succeed(null) }),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),

      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      Layer.mock(CrewProposalService)({}),
      ServerConfig.layerTest(process.cwd(), { prefix: "j5-mcp-list-agents-" }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));
    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const response = yield* toolkit
        .handle("list_personas", {})
        .pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(McpInvocationContext, invocation),
        );
      assert.isFalse(response.isFailure);
      const { personas } = response.result as {
        readonly personas: ReadonlyArray<{
          readonly id: string;
          readonly runtime_policy: string;
          readonly availability: string;
          readonly route: string | null;
        }>;
      };
      assert.lengthOf(personas, 11);
      const scout = personas.find((persona) => persona.id === "scout");
      assert.deepStrictEqual(
        [scout?.runtime_policy, scout?.availability, scout?.route],
        ["read-only", "available", "codex · gpt-5.6-terra · high"],
      );
      // Publisher's publish-only policy has no enforceable provider yet, so it cannot start.
      const publisher = personas.find((persona) => persona.id === "publisher");
      assert.deepStrictEqual([publisher?.availability, publisher?.route], ["blocked", null]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("routes crew proposals through a captain that is not itself a crew member", () =>
  Effect.gen(function* () {
    const squadronId = SquadronId.make("squadron:j5:mcp-propose");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-propose-captain");
    const proposals = yield* Ref.make<ReadonlyArray<string>>([]);
    const proposedSeats = yield* Ref.make<ReadonlyArray<CrewProposalSeat>>([]);
    const addedSeats = yield* Ref.make<ReadonlyArray<CrewProposalSeat>>([]);
    const membership = yield* Ref.make<{ crewInstanceId: string; seatName: string } | null>(null);
    const callerRow = {
      squadronId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const proposal = (requestKey: string, kind: "roster" | "addition"): CrewProposal => ({
      id: `proposal:${requestKey}`,
      squadronId,
      captainParticipantId: callerParticipantId,
      captainThreadId: invocation.threadId,
      crewInstanceId: kind === "addition" ? "crew:1" : null,
      kind,
      status: "open",
      brief: "Fix the flaky login test.",
      displayName: "Login Fix Crew",
      requestedSeats: [{ seat: "builder", agentId: "builder", reason: "Implements" }],
      approvedSeats: null,
      createdAt: "2026-09-09T16:00:00.000Z",
      resolvedAt: null,
      reportedAt: null,
    });
    const dependencies = Layer.mergeAll(
      Layer.mock(A2ASendService)({ listParticipants: () => Effect.succeed([callerRow]) }),
      Layer.mock(A2AHomeRegistrar)({
        getHomeForThread: () => Effect.succeed({ squadronId, participantId: callerParticipantId }),
      }),
      Layer.mock(A2ALedger)({
        readSquadron: () =>
          Effect.succeed({
            id: squadronId,
            name: "Propose",
            createdAt: DateTime.formatIso(createdAt),
          }),
      }),
      Layer.mock(SpawnCompositionService)({}),
      Layer.mock(ThreadManagementService)({
        getThreadProjection: (threadId) => Effect.succeed(projection(threadId)),
      }),
      Layer.mock(OrchestratorMcpService)({}),
      Layer.mock(ProviderRegistry)({}),
      Layer.mock(AgentCrewInstanceService)({
        findMembership: () => Ref.get(membership),
        listForCaptain: () => Effect.succeed([]),
      }),
      Layer.mock(CrewProposalService)({
        propose: (input) =>
          Ref.update(proposals, (items) => [...items, input.requestKey]).pipe(
            Effect.as({
              proposal: proposal(input.requestKey, "roster"),
              instance: null,
            } satisfies CrewProposalOutcome),
            Effect.tap(() => Ref.set(proposedSeats, input.seats)),
          ),
        requestMember: (input) =>
          Ref.update(proposals, (items) => [...items, input.requestKey]).pipe(
            Effect.tap(() => Ref.update(addedSeats, (seats) => [...seats, input.seat])),
            Effect.as({
              proposal: {
                ...proposal(input.requestKey, "addition"),
                status: "approved" as const,
              },
              instance: {
                id: "crew:1",
                squadronId,
                captainParticipantId: callerParticipantId,
                captainThreadId: invocation.threadId,
                displayName: "Login Fix Crew",
                brief: "Fix the flaky login test.",
                version: 2,
                createdAt: "2026-09-09T16:00:00.000Z",
                archivedAt: null,
                members: [
                  {
                    seatName: input.seat.seat,
                    agentId: input.seat.agentId,
                    participantId: ParticipantId.make("agent:j5:a2a:thread:new"),
                    threadId: ThreadId.make("thread:new"),
                    addedVersion: 2,
                    reason: input.seat.reason,
                  },
                ],
              },
            } satisfies CrewProposalOutcome),
          ),
      }),
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),

      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));
    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const run = <K extends "propose_crew" | "request_crew_member" | "spawn_agent">(
        tool: K,
        args: K extends "propose_crew"
          ? J5ProposeCrewInput
          : K extends "spawn_agent"
            ? J5SpawnAgentInput
            : J5RequestCrewMemberInput,
      ) =>
        toolkit
          .handle(tool, args as never)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );
      const message = (response: { readonly result: unknown }) =>
        (response.result as { readonly message: string }).message;

      const customSelection: ModelSelection = {
        instanceId: ProviderInstanceId.make("codex-custom"),
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      const proposed = yield* run("propose_crew", {
        name: "Login Fix Crew",
        brief: "Fix the flaky login test.",
        seats: [
          { seat: "builder", persona: "builder", reason: "Implements" },
          {
            seat: "reviewer",
            reason: "Reviews correctness",
            instructions: "Review and report concrete risks.",
            model_selection: customSelection,
            runtime_mode: "approval-required",
          },
          { seat: "researcher", reason: "Researches", instructions: "Inspect related behavior." },
        ],
        client_request_id: "propose-1",
      });
      assert.isFalse(proposed.isFailure, message(proposed));
      assert.deepStrictEqual(proposed.result, {
        proposal_id: `proposal:${invocation.providerSessionId}:propose-1`,
        status: "open",
        crew_instance_id: null,
        members: [],
      });

      assert.deepStrictEqual(yield* Ref.get(proposedSeats), [
        { seat: "builder", agentId: "builder", reason: "Implements" },
        {
          seat: "reviewer",
          agentId: null,
          reason: "Reviews correctness",
          instructions: "Review and report concrete risks.",
          modelSelection: customSelection,
          runtimeMode: "approval-required",
        },
        {
          seat: "researcher",
          agentId: null,
          reason: "Researches",
          instructions: "Inspect related behavior.",
        },
      ]);

      const added = yield* run("request_crew_member", {
        seat: "security",
        reason: "Security pass",
        instructions: "Review authorization boundaries.",
        model_selection: customSelection,
        runtime_mode: "auto-accept-edits",
        client_request_id: "add-1",
      });
      assert.isFalse(added.isFailure, message(added));
      const addedResult = added.result as unknown as {
        status: string;
        crew_instance_id: string;
        members: unknown[];
      };
      assert.equal(addedResult.status, "approved");
      assert.equal(addedResult.crew_instance_id, "crew:1");
      assert.lengthOf(addedResult.members, 1);
      assert.deepStrictEqual(yield* Ref.get(addedSeats), [
        {
          seat: "security",
          agentId: null,
          reason: "Security pass",
          instructions: "Review authorization boundaries.",
          modelSelection: customSelection,
          runtimeMode: "auto-accept-edits",
        },
      ]);

      yield* Ref.set(membership, { crewInstanceId: "crew:1", seatName: "builder" });
      const refused = yield* run("propose_crew", {
        name: "Nested",
        brief: "x",
        seats: [{ seat: "s", persona: "scout", reason: "r" }],
      });
      assert.isTrue(refused.isFailure);
      assert.include(message(refused), "crew members cannot request crews or seats");
      assert.lengthOf(yield* Ref.get(proposals), 2);
      // Nor may a seat spawn a solo Peer Agent: only the Captain grows a Crew, through the gate.
      const spawned = yield* run("spawn_agent", {
        brief: "Help me",
        provider: "codex",
        model: "gpt-5.6-terra",
        reasoning: "high",
      } as J5SpawnAgentInput);
      assert.isTrue(spawned.isFailure);
      assert.include(message(spawned), "crew members cannot spawn Peer Agents");
      assert.include(message(spawned), "delegate_task");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("stops exactly one placed agent without consulting or touching descendants", () =>
  Effect.gen(function* () {
    const squadronId = SquadronId.make("squadron:j5:mcp-stop");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-stop-caller");
    const targetParticipantId = ParticipantId.make("agent:j5:mcp-stop-target");
    const siblingParticipantId = ParticipantId.make("agent:j5:mcp-stop-sibling");
    const childParticipantId = ParticipantId.make("agent:j5:mcp-stop-child");
    const targetThreadId = ThreadId.make("thread:j5:mcp-stop-target");
    const siblingThreadId = ThreadId.make("thread:j5:mcp-stop-sibling");
    const childThreadId = ThreadId.make("thread:j5:mcp-stop-child");
    const targetProjectId = ProjectId.make("project:j5:mcp-stop-target");
    const interrupted = yield* Ref.make<
      ReadonlyArray<{
        readonly commandId: string;
        readonly projectId: ProjectId;
        readonly threadId: ThreadId;
      }>
    >([]);
    const callerRow = {
      squadronId,
      participantId: callerParticipantId,
      participant: {
        kind: "agent" as const,
        id: callerParticipantId,
        threadId: invocation.threadId,
      },
      archived: false,
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const agentRow = (participantId: ParticipantId, threadId: ThreadId, parent: ParticipantId) => ({
      squadronId,
      participantId,
      participant: { kind: "agent" as const, id: participantId, threadId },
      threadId,
      provenance: {
        kind: "spawned-by" as const,
        spawnedByParticipantId: parent,
        source: "j5_spawn" as const,
      },
      placementParentId: parent,
    });
    const dependencies = Layer.mergeAll(
      Layer.succeed(
        A2ASendService,
        A2ASendService.of({
          send: () => Effect.die("send_message is outside this stop test"),
          clearOwnAsk: () => Effect.die("clear_own_ask is outside this stop test"),
          sendAsMachine: () => Effect.die("unused"),
          listParticipants: () => Effect.succeed([callerRow]),
        }),
      ),
      Layer.mock(ParticipantPlacementService)({
        listParticipants: () =>
          Effect.succeed([
            agentRow(targetParticipantId, targetThreadId, callerParticipantId),
            agentRow(siblingParticipantId, siblingThreadId, callerParticipantId),
            agentRow(childParticipantId, childThreadId, targetParticipantId),
          ]),
        listSubtree: () => Effect.die("stop_agent must never resolve placement descendants"),
      }),
      Layer.mock(ThreadManagementService)({
        getThreadProjection: (threadId) =>
          Effect.succeed({
            ...projection(threadId),
            thread: {
              ...projection(threadId).thread,
              projectId: threadId === targetThreadId ? targetProjectId : projectId,
            },
          }),
        interruptThread: (input) =>
          Ref.update(interrupted, (items) => [
            ...items,
            {
              commandId: input.commandId,
              projectId: input.projectId,
              threadId: input.threadId,
            },
          ]).pipe(
            Effect.as(
              String(input.commandId).includes("stop-idle")
                ? ({ type: "no_active_run" } as const)
                : ({
                    type: "interrupt_requested" as const,
                    run: {} as never,
                    dispatch: {} as never,
                  } as const),
            ),
          ),
      }),
      Layer.mock(A2AHomeRegistrar)({}),
      Layer.mock(A2ALedger)({}),
      Layer.mock(SpawnCompositionService)({}),
      Layer.mock(OrchestratorMcpService)({}),
      peerDirectoryNoneLayer,
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(AgentCrewInstanceService)({
        findMembership: () => Effect.succeed(null),
        listForCaptain: () => Effect.succeed([]),
      }),
      Layer.mock(ArchiveCrewService)({}),
      Layer.mock(CrewStopService)({}),
      Layer.mock(CrewProposalService)({}),

      Layer.mock(SquadronJoinService)({}),
      Layer.mock(SquadronProjectReferences)({}),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const call = (args: J5StopAgentInput) =>
        toolkit
          .handle("stop_agent", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );
      const args = {
        squadron_id: squadronId,
        participant_id: targetParticipantId,
        client_request_id: "stop-one-1",
      } satisfies J5StopAgentInput;
      const first = yield* call(args);
      const replay = yield* call(args);
      assert.equal(first.result, "interrupt_requested");
      assert.deepStrictEqual(replay.result, first.result);
      const idle = yield* call({
        ...args,
        client_request_id: "stop-idle-1",
      });
      assert.equal(idle.result, "already_idle");
      const crossSquadron = yield* call({
        ...args,
        squadron_id: SquadronId.make("squadron:j5:mcp-stop-other"),
        client_request_id: "stop-cross-squadron",
      });
      assert.isTrue(crossSquadron.isFailure);
      assert.include(
        (crossSquadron.result as unknown as { readonly message: string }).message,
        `currently in Squadron ${squadronId}`,
      );
      const calls = yield* Ref.get(interrupted);
      assert.deepStrictEqual(
        calls.map((call) => call.threadId),
        [targetThreadId, targetThreadId, targetThreadId],
      );
      assert.equal(calls[0]?.commandId, calls[1]?.commandId);
      assert.isTrue(calls.every((call) => call.projectId === targetProjectId));
      assert.notInclude(
        calls.map((call) => call.threadId),
        siblingThreadId,
      );
      assert.notInclude(
        calls.map((call) => call.threadId),
        childThreadId,
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "lists agents homed on peer servers beside local ones and reports the peers it could not read",
  () =>
    Effect.gen(function* () {
      const squadronId = SquadronId.make("squadron:j5:mcp-peer-list");
      const callerParticipantId = ParticipantId.make("agent:j5:mcp-peer-caller");
      const remoteParticipantId = ParticipantId.make("agent:j5:a2a:thread:support");
      const archivedRemoteId = ParticipantId.make("agent:j5:a2a:thread:retired");
      const callerRow = {
        squadronId,
        participantId: callerParticipantId,
        participant: {
          kind: "agent" as const,
          id: callerParticipantId,
          threadId: invocation.threadId,
        },
        archived: false,
        canReceiveMessage: true,
        canOpenExchange: true,
        acceptsUrgency: false,
      } satisfies ParticipantDirectoryRow;
      const remoteAgent = {
        environmentId: "environment-home",
        environmentLabel: "Home",
        squadronId: SquadronId.make("squadron:home-support"),
        squadronName: "L2 Support Rotation",
        participantId: remoteParticipantId,
        threadId: ThreadId.make("thread:support"),
        displayName: "Support triage",
        archived: false,
        canReceiveMessage: true,
      };
      const dependencies = Layer.mergeAll(
        Layer.succeed(
          A2ASendService,
          A2ASendService.of({
            send: () => Effect.die("unused"),
            clearOwnAsk: () => Effect.die("unused"),
            sendAsMachine: () => Effect.die("unused"),
            listParticipants: () => Effect.succeed([callerRow]),
          }),
        ),
        Layer.mock(ParticipantPlacementService)({ listParticipants: () => Effect.succeed([]) }),
        Layer.succeed(
          PeerDirectory,
          PeerDirectory.of({
            listAgents: () =>
              Effect.succeed({
                agents: [
                  remoteAgent,
                  {
                    ...remoteAgent,
                    participantId: archivedRemoteId,
                    threadId: ThreadId.make("thread:retired"),
                    displayName: "Retired",
                    archived: true,
                    canReceiveMessage: false,
                  },
                ],
                unreadPeers: [
                  { environmentId: "environment-mac", label: "Mac", reason: "ECONNREFUSED" },
                ],
              }),
            resolveAgent: () => Effect.die("unused"),
          }),
        ),
        Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
        Layer.mock(OrchestratorV2)({
          getShellSnapshot: () =>
            Effect.fail(new OrchestratorProjectionError({ threadId: invocation.threadId })),
        }),
        Layer.mock(A2AHomeRegistrar)({}),
        Layer.mock(A2ALedger)({ listSquadrons: () => Effect.succeed([]) }),
        Layer.mock(SpawnCompositionService)({}),
        Layer.mock(ThreadManagementService)({}),
        Layer.mock(OrchestratorMcpService)({}),
        Layer.mock(AgentCrewInstanceService)({
          findMembership: () => Effect.succeed(null),
          listForCaptain: () => Effect.succeed([]),
        }),
        Layer.mock(ArchiveCrewService)({}),
        Layer.mock(CrewStopService)({}),
        Layer.mock(CrewProposalService)({}),
        Layer.mock(SquadronJoinService)({}),
        Layer.mock(SquadronProjectReferences)({}),
        NodeServices.layer,
      );
      const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

      yield* Effect.gen(function* () {
        const toolkit = yield* J5Toolkit;
        const callList = (include_archived: boolean) =>
          toolkit.handle("list_participants", { include_archived }).pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
            Effect.flatMap((response) => decodeJ5ListParticipantsResult(response.encodedResult)),
          );
        const listed = yield* callList(false);
        assert.deepStrictEqual(
          listed.participants.map((row) => [row.participant_id, row.squadron_id]),
          [
            [callerParticipantId, squadronId],
            [remoteParticipantId, "squadron:home-support"],
          ],
          "an archived remote agent is hidden until asked for, like a local one",
        );
        const remoteRow = listed.participants[1]!;
        assert.equal(remoteRow.display_name, "Support triage");
        assert.equal(remoteRow.squadron_name, "L2 Support Rotation");
        assert.equal(listed.participants[0]!.squadron_name, null);
        assert.equal(remoteRow.can_receive_message, true);
        assert.equal(remoteRow.can_open_exchange, true);
        assert.equal(remoteRow.self, false);
        assert.equal(remoteRow.thread_id, "thread:support");
        assert.deepStrictEqual(remoteRow.provenance, { kind: "unrecorded" });
        assert.isFalse(hasKey(remoteRow, "environment_id"), "no verb reveals a server");
        assert.equal(listed.unread_peer_count, 1, "an unread peer is counted, never named");
        assert.isFalse(hasKey(listed, "unread_peers"));

        const withArchived = yield* callList(true);
        assert.deepStrictEqual(
          withArchived.participants.map((row) => [row.participant_id, row.archived]),
          [
            [callerParticipantId, false],
            [remoteParticipantId, false],
            [archivedRemoteId, true],
          ],
        );
        assert.equal(withArchived.participants[2]!.can_receive_message, false);
      }).pipe(Effect.provide(layer));
    }),
);
