import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ThreadId,
  type OrchestratorMcpDelegateTaskInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AHomeRegistrar } from "../HomeRegistrar.ts";
import { A2ALedger, SquadronNotFoundError } from "../LedgerService.ts";
import { PlacementCascadeService } from "../PlacementCascadeService.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { A2ASendService } from "../SendService.ts";
import {
  GLOBAL_HUMAN_PARTICIPANT_ID,
  LedgerMessageId,
  ParticipantId,
  SquadronId,
  type ParticipantDirectoryRow,
  type SendMessageInput,
} from "../contracts.ts";
import type { RecordParticipantPlacementInput } from "../placementContracts.ts";
import { J5ToolkitHandlersLive } from "./handlers.ts";
import { J5Toolkit, type J5SendMessageInput, type J5SpawnAgentInput } from "./tools.ts";

interface PlacementCascadeArgs {
  readonly client_request_id: string;
  readonly squadron_id: SquadronId;
  readonly participant_id: ParticipantId;
}

const invocation = {
  environmentId: EnvironmentId.make("environment:j5:mcp-handler"),
  threadId: ThreadId.make("thread:j5:mcp-handler"),
  providerSessionId: "provider-session:j5:mcp-handler",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};

it.effect("derives send idempotency and sender identity from authenticated scope", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(Object.keys(J5Toolkit.tools).sort(), [
      "archive_agent",
      "list_participants",
      "send_message",
      "spawn_agent",
      "stop_agent",
    ]);
    const sends = yield* Ref.make<ReadonlyArray<SendMessageInput>>([]);
    const participantId = ParticipantId.make("agent:j5:mcp-handler");
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
        listParticipants: () => Effect.succeed([]),
      }),
    );
    const dependencies = Layer.mergeAll(
      sendService,
      Layer.mock(ParticipantPlacementService)({}),
      Layer.mock(PlacementCascadeService)({}),
      Layer.mock(A2ALedger)({}),
      Layer.mock(A2AHomeRegistrar)({}),
      Layer.mock(OrchestratorMcpService)({}),
      Layer.mock(ThreadManagementService)({}),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
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
      const captured = yield* Ref.get(sends);
      assert.lengthOf(captured, 2);
      assert.equal(captured[0]?.commandId, captured[1]?.commandId);
      assert.equal(captured[0]?.senderThreadId, invocation.threadId);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("registers and places a fixed-spawner child after unchanged upstream delegation", () =>
  Effect.gen(function* () {
    const squadronId = SquadronId.make("squadron:j5:mcp-spawn");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-spawn-caller");
    const childParticipantId = ParticipantId.make("agent:j5:mcp-spawn-child");
    const childThreadId = ThreadId.make("thread:j5:mcp-spawn-child");
    const departedParentParticipantId = ParticipantId.make("agent:j5:mcp-spawn-departed");
    const departedParentThreadId = ThreadId.make("thread:j5:mcp-spawn-departed");
    const taskId = NodeId.make("node:j5:mcp-spawn-task");
    const createdAt = "2026-08-27T20:00:00.000Z";
    const steps = yield* Ref.make<ReadonlyArray<string>>([]);
    const delegatedInputs = yield* Ref.make<ReadonlyArray<OrchestratorMcpDelegateTaskInput>>([]);
    const homeInputs = yield* Ref.make<
      ReadonlyArray<{
        readonly commandId: string;
        readonly squadronId: SquadronId;
        readonly threadId: ThreadId;
      }>
    >([]);
    const placementInputs = yield* Ref.make<ReadonlyArray<RecordParticipantPlacementInput>>([]);
    const callerPlaced = yield* Ref.make(false);
    const childPlaced = yield* Ref.make(false);
    const missingSquadron = yield* Ref.make(false);
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
    const delegation = {
      taskId,
      childThreadId,
      childRunId: null,
      childNodeId: NodeId.make("node:j5:mcp-spawn-child"),
      status: "waiting" as const,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-fable-5",
      summary: null,
      resultContextTransferId: null,
      waitTimedOut: false,
    };
    const placementResult = (
      input: RecordParticipantPlacementInput,
      placementParentId: ParticipantId | null,
      seq: number,
      committed: boolean,
    ) => ({
      event: {
        seq,
        commandId: input.commandId,
        squadronId: input.squadronId,
        participantId: input.participantId,
        kind: "participant.placement_created" as const,
        actor: input.actor,
        provenance: input.provenance,
        previousParentId: null,
        placementParentId,
        createdAt: input.createdAt,
      },
      placement: {
        squadronId: input.squadronId,
        participantId: input.participantId,
        provenance: input.provenance,
        placementParentId,
        createdEventSeq: seq,
        updatedEventSeq: seq,
      },
      committed,
    });

    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("send_message is outside this spawn-handler test"),
        listParticipants: () => Effect.succeed([callerRow]),
      }),
    );
    const ledger = Layer.mock(A2ALedger)({
      readSquadron: (requestedSquadronId) =>
        Ref.update(steps, (items) => [...items, "squadron-preflight"]).pipe(
          Effect.andThen(Ref.get(missingSquadron)),
          Effect.flatMap((missing) =>
            missing
              ? Effect.fail(new SquadronNotFoundError({ squadronId: requestedSquadronId }))
              : Effect.succeed({
                  id: requestedSquadronId,
                  name: "Spawn wrapper test",
                  createdAt,
                }),
          ),
        ),
      findHistoricalAgentParticipantId: () =>
        Ref.update(steps, (items) => [...items, "historical-parent"]).pipe(
          Effect.as(departedParentParticipantId),
        ),
    });
    const placements = Layer.mock(ParticipantPlacementService)({
      readPlacement: () =>
        Ref.update(steps, (items) => [...items, "caller-placement-read"]).pipe(
          Effect.andThen(Ref.get(callerPlaced)),
          Effect.map((exists) =>
            exists
              ? {
                  squadronId,
                  participantId: callerParticipantId,
                  provenance: {
                    kind: "unknown" as const,
                    source: "native_or_unobserved" as const,
                  },
                  placementParentId: null,
                  createdEventSeq: 1,
                  updatedEventSeq: 1,
                }
              : null,
          ),
        ),
      recordCreation: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(placementInputs, (items) => [...items, input]);
          if (input.participantId === callerParticipantId) {
            yield* Ref.update(steps, (items) => [...items, "caller-placement-record"]);
            const replay = yield* Ref.get(callerPlaced);
            yield* Ref.set(callerPlaced, true);
            return placementResult(input, null, 1, !replay);
          }
          yield* Ref.update(steps, (items) => [...items, "child-placement-record"]);
          const replay = yield* Ref.get(childPlaced);
          yield* Ref.set(childPlaced, true);
          return placementResult(input, callerParticipantId, 2, !replay);
        }),
    });
    const threads = Layer.mock(ThreadManagementService)({
      getThreadProjection: (threadId) =>
        Ref.update(steps, (items) => [
          ...items,
          threadId === invocation.threadId ? "caller-projection" : "child-projection",
        ]).pipe(
          Effect.as({
            thread: {
              createdAt,
              lineage:
                threadId === invocation.threadId
                  ? {
                      parentThreadId: departedParentThreadId,
                      relationshipToParent: "subagent",
                    }
                  : {
                      parentThreadId: invocation.threadId,
                      relationshipToParent: "subagent",
                    },
            },
          } as never),
        ),
    });
    const orchestrator = Layer.mock(OrchestratorMcpService)({
      delegateTask: (_scope, input) =>
        Effect.gen(function* () {
          yield* Ref.update(steps, (items) => [...items, "delegate"]);
          yield* Ref.update(delegatedInputs, (items) => [...items, input]);
          return delegation;
        }),
    });
    const registrar = Layer.mock(A2AHomeRegistrar)({
      registerAtCreation: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(steps, (items) => [...items, "register-home"]);
          yield* Ref.update(homeInputs, (items) => [...items, input]);
          return { squadronId, participantId: childParticipantId };
        }),
    });
    const dependencies = Layer.mergeAll(
      sendService,
      ledger,
      placements,
      threads,
      orchestrator,
      registrar,
      Layer.mock(PlacementCascadeService)({}),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const callSpawn = (args: J5SpawnAgentInput) =>
        toolkit
          .handle("spawn_agent", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );
      const args = {
        task: "Run the isolated receiver proof",
        target: { providerInstanceId: ProviderInstanceId.make("claudeAgent") },
        mode: "async" as const,
        clientRequestId: "spawn-wrapper-replay-1",
      } satisfies J5SpawnAgentInput;

      const first = yield* callSpawn(args);
      const replay = yield* callSpawn(args);
      assert.isFalse(first.isFailure);
      assert.isFalse(replay.isFailure);
      assert.deepStrictEqual(yield* Ref.get(delegatedInputs), [args, args]);
      assert.deepStrictEqual(yield* Ref.get(steps), [
        "squadron-preflight",
        "caller-placement-read",
        "caller-projection",
        "historical-parent",
        "caller-placement-record",
        "delegate",
        "child-projection",
        "register-home",
        "child-placement-record",
        "squadron-preflight",
        "caller-placement-read",
        "delegate",
        "child-projection",
        "register-home",
        "child-placement-record",
      ]);
      const registrations = yield* Ref.get(homeInputs);
      assert.lengthOf(registrations, 2);
      assert.equal(registrations[0]?.squadronId, squadronId);
      assert.equal(registrations[0]?.threadId, childThreadId);
      assert.equal(registrations[0]?.commandId, registrations[1]?.commandId);
      const recorded = yield* Ref.get(placementInputs);
      assert.deepStrictEqual(recorded[0]?.provenance, {
        kind: "spawned-by",
        spawnedByParticipantId: departedParentParticipantId,
        source: "upstream_lineage",
      });
      const childRecords = recorded.filter((input) => input.participantId === childParticipantId);
      assert.lengthOf(childRecords, 2);
      assert.equal(childRecords[0]?.commandId, childRecords[1]?.commandId);
      assert.deepStrictEqual(childRecords[0]?.provenance, {
        kind: "spawned-by",
        spawnedByParticipantId: callerParticipantId,
        source: "j5_wrapper",
      });

      yield* Ref.set(missingSquadron, true);
      yield* Ref.set(steps, []);
      const delegatedBeforeFailure = (yield* Ref.get(delegatedInputs)).length;
      const missing = yield* callSpawn({ ...args, clientRequestId: "missing-squadron" });
      assert.isTrue(missing.isFailure);
      assert.equal(
        (missing.result as unknown as { readonly code: string }).code,
        "SquadronNotFoundError",
      );
      assert.deepStrictEqual(yield* Ref.get(steps), ["squadron-preflight"]);
      assert.lengthOf(yield* Ref.get(delegatedInputs), delegatedBeforeFailure);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("enriches participants and authorizes cascades before placement dispatch", () =>
  Effect.gen(function* () {
    const squadronId = SquadronId.make("squadron:j5:mcp-placement-handler");
    const otherSquadronId = SquadronId.make("squadron:j5:mcp-placement-other");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-placement-caller");
    const displayParentId = ParticipantId.make("agent:j5:mcp-display-parent");
    const childParticipantId = ParticipantId.make("agent:j5:mcp-placement-child");
    const childThreadId = ThreadId.make("thread:j5:mcp-placement-child");
    const cascadeCommands = yield* Ref.make<
      ReadonlyArray<{ operation: string; commandId: string }>
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
    const humanRow = {
      squadronId,
      participantId: GLOBAL_HUMAN_PARTICIPANT_ID,
      participant: { kind: "human" as const },
      canReceiveMessage: true,
      canOpenExchange: true,
      acceptsUrgency: true,
    } satisfies ParticipantDirectoryRow;
    const directoryRows = yield* Ref.make<ReadonlyArray<ParticipantDirectoryRow>>([
      callerRow,
      humanRow,
    ]);
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("send_message is outside this placement-handler test"),
        listParticipants: () => Ref.get(directoryRows),
      }),
    );
    const placementService = Layer.mock(ParticipantPlacementService)({
      listParticipants: () =>
        Effect.succeed([
          {
            squadronId,
            participantId: callerParticipantId,
            participant: callerRow.participant,
            threadId: invocation.threadId,
            provenance: { kind: "unknown" as const, source: "native_or_unobserved" as const },
            placementParentId: displayParentId,
          },
        ]),
    });
    const cascades = Layer.mock(PlacementCascadeService)({
      stop: (input) =>
        Ref.update(cascadeCommands, (items) => [
          ...items,
          { operation: "stop", commandId: input.commandId },
        ]).pipe(
          Effect.as([
            {
              participantId: childParticipantId,
              threadId: childThreadId,
              outcome: "interrupt_requested" as const,
            },
          ]),
        ),
      archive: (input) =>
        Ref.update(cascadeCommands, (items) => [
          ...items,
          { operation: "archive", commandId: input.commandId },
        ]).pipe(
          Effect.as([
            {
              participantId: childParticipantId,
              threadId: childThreadId,
              outcome: "archived" as const,
            },
          ]),
        ),
    });
    const dependencies = Layer.mergeAll(
      sendService,
      placementService,
      cascades,
      Layer.mock(A2ALedger)({}),
      Layer.mock(A2AHomeRegistrar)({}),
      Layer.mock(OrchestratorMcpService)({}),
      Layer.mock(ThreadManagementService)({}),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
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
      const callStop = (args: PlacementCascadeArgs) =>
        toolkit
          .handle("stop_agent", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );
      const callArchive = (args: PlacementCascadeArgs) =>
        toolkit
          .handle("archive_agent", args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );

      const listed = yield* callList();
      const listedRows = (
        listed.result as unknown as {
          readonly participants: ReadonlyArray<{
            readonly provenance: { readonly kind: string };
            readonly placementParentId: ParticipantId | null;
          }>;
        }
      ).participants;
      assert.equal(listedRows[0]?.provenance.kind, "unknown");
      assert.equal(listedRows[0]?.placementParentId, displayParentId);
      assert.deepStrictEqual(listedRows[1]?.provenance, { kind: "not-applicable" });
      assert.equal(listedRows[1]?.placementParentId, null);

      yield* callStop({
        client_request_id: "cascade-stop-1",
        squadron_id: squadronId,
        participant_id: childParticipantId,
      });
      yield* callArchive({
        client_request_id: "cascade-archive-1",
        squadron_id: squadronId,
        participant_id: childParticipantId,
      });
      assert.deepStrictEqual(
        (yield* Ref.get(cascadeCommands)).map(({ operation, commandId }) => ({
          operation,
          commandId: String(commandId),
        })),
        [
          {
            operation: "stop",
            commandId:
              "command:j5:a2a:placement:mcp:provider-session%3Aj5%3Amcp-handler:cascade-stop-1:stop",
          },
          {
            operation: "archive",
            commandId:
              "command:j5:a2a:placement:mcp:provider-session%3Aj5%3Amcp-handler:cascade-archive-1:archive",
          },
        ],
      );

      const crossSquadron = yield* callStop({
        client_request_id: "cross-squadron-stop",
        squadron_id: otherSquadronId,
        participant_id: childParticipantId,
      });
      assert.isTrue(crossSquadron.isFailure);
      assert.include(
        (crossSquadron.result as unknown as { message: string }).message,
        `current Squadron is ${squadronId}, but stop_agent targeted ${otherSquadronId}`,
      );
      assert.lengthOf(yield* Ref.get(cascadeCommands), 2);

      yield* Ref.set(directoryRows, []);
      const missing = yield* callArchive({
        client_request_id: "missing-caller",
        squadron_id: squadronId,
        participant_id: childParticipantId,
      });
      assert.isTrue(missing.isFailure);
      assert.include(
        (missing.result as unknown as { message: string }).message,
        "missing for thread",
      );
      assert.lengthOf(yield* Ref.get(cascadeCommands), 2);

      yield* Ref.set(directoryRows, [callerRow, { ...callerRow, squadronId: otherSquadronId }]);
      const ambiguous = yield* callStop({
        client_request_id: "ambiguous-caller",
        squadron_id: squadronId,
        participant_id: childParticipantId,
      });
      assert.isTrue(ambiguous.isFailure);
      assert.include(
        (ambiguous.result as unknown as { message: string }).message,
        `ambiguous across current Squadrons ${squadronId}, ${otherSquadronId}`,
      );
      assert.lengthOf(yield* Ref.get(cascadeCommands), 2);
    }).pipe(Effect.provide(layer));
  }),
);
