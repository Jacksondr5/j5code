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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorProjectionError,
  OrchestratorV2,
} from "../../../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AHomeNotFoundError, A2AHomeRegistrar } from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { ParticipantPlacementService, PlacementStorageError } from "../PlacementService.ts";
import { A2ASendService } from "../SendService.ts";
import { SpawnCompositionService } from "../SpawnCompositionService.ts";
import {
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
  type J5SendMessageInput,
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
  Layer.mock(A2AHomeRegistrar)({}),
  Layer.mock(A2ALedger)({}),
  Layer.mock(SpawnCompositionService)({}),
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(OrchestratorMcpService)({}),
);

it.effect("derives send idempotency and sender identity from authenticated scope", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(Object.keys(J5Toolkit.tools).sort(), [
      "list_participants",
      "send_message",
      "spawn_agent",
      "stop_agent",
    ]);
    assert.notProperty(J5Toolkit.tools, "archive_agent");
    const sends = yield* Ref.make<ReadonlyArray<SendMessageInput>>([]);
    const participantId = ParticipantId.make("agent:j5:mcp-handler");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-seeded-caller");
    const callerSquadronId = SquadronId.make("squadron:j5:mcp-seeded-caller");
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: (input) =>
          Ref.update(sends, (items) => [...items, input]).pipe(
            Effect.as({
              messageId: LedgerMessageId.make("message:j5:mcp-handler"),
              exchangeId: null,
              exchangeState: "none" as const,
              joinedExistingExchange: false,
              durableAtSeq: 1,
            }),
          ),
        listParticipants: () =>
          Effect.succeed([
            {
              squadronId: callerSquadronId,
              participantId: callerParticipantId,
              participant: {
                kind: "agent" as const,
                id: callerParticipantId,
                threadId: invocation.threadId,
              },
              canReceiveMessage: true,
              canOpenExchange: true,
              acceptsUrgency: false,
            },
          ]),
      }),
    );
    const dependencies = Layer.mergeAll(
      sendService,
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(OrchestratorV2)({}),
      unusedLifecycleDependencies,
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
      const sendArguments = {
        to: participantId,
        message: "Idempotent MCP send",
        client_request_id: "logical-send-1",
      };
      yield* call(sendArguments);
      yield* call(sendArguments);
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
      const captured = yield* Ref.get(sends);
      assert.lengthOf(captured, 2);
      assert.equal(captured[0]?.commandId, captured[1]?.commandId);
      assert.equal(captured[0]?.senderThreadId, invocation.threadId);
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
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const humanRow = {
      squadronId,
      participantId: personParticipantId,
      participant: { kind: "human" as const, id: personParticipantId },
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: true,
    } satisfies ParticipantDirectoryRow;
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("send_message is outside this placement-handler test"),
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
        participant_id: activeParticipantId,
        participant: { kind: "agent", id: activeParticipantId, thread_id: activeThreadId },
        self: false,
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
        participant_id: archivedParticipantId,
        participant: { kind: "agent", id: archivedParticipantId, thread_id: archivedThreadId },
        self: false,
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
        participant_id: missingParticipantId,
        participant: { kind: "agent", id: missingParticipantId, thread_id: missingThreadId },
        self: false,
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
        participant_id: humanParticipantId,
        participant: { kind: "human", id: humanParticipantId },
        self: false,
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
        canReceiveMessage: true,
        canOpenExchange: true,
        acceptsUrgency: false,
      },
      {
        squadronId,
        participantId: humanParticipantId,
        participant: { kind: "human", id: humanParticipantId },
        canReceiveMessage: true,
        canOpenExchange: true,
        acceptsUrgency: true,
      },
    ];
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("unused"),
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
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: false,
    } satisfies ParticipantDirectoryRow;
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("send_message is outside this spawn test"),
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
        String(input.threadId).includes("spawn-facts-fail")
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
                    spawnedByParticipantId: input.spawnedByParticipantId,
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
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
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
          `<j5_spawn_context>\nPlatform-provided identity facts:\nparticipant_id: ${childParticipantId}\nsquadron_id: ${squadronId}\nsquadron_name: ${squadronName}\n</j5_spawn_context>\n\n<spawner_brief>\n${args.brief}\n</spawner_brief>`,
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
      Layer.mock(ThreadManagementService)({
        dispatch: () => Ref.update(dispatches, (count) => count + 1).pipe(Effect.as({} as never)),
      }),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
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
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
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
