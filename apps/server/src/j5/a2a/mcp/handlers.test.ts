import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { PlacementCascadeService } from "../PlacementCascadeService.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { A2ASendService } from "../SendService.ts";
import {
  LedgerMessageId,
  ParticipantId,
  SquadronId,
  type SendMessageInput,
} from "../contracts.ts";
import { J5ToolkitHandlersLive } from "./handlers.ts";
import { J5Toolkit, type J5SendMessageInput } from "./tools.ts";

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

it.effect("enriches participants and reaches placement cascades through the shared toolkit", () =>
  Effect.gen(function* () {
    const squadronId = SquadronId.make("squadron:j5:mcp-placement-handler");
    const callerParticipantId = ParticipantId.make("agent:j5:mcp-placement-caller");
    const childParticipantId = ParticipantId.make("agent:j5:mcp-placement-child");
    const childThreadId = ThreadId.make("thread:j5:mcp-placement-child");
    const cascadeCommands = yield* Ref.make<
      ReadonlyArray<{ operation: string; commandId: string }>
    >([]);
    const sendService = Layer.succeed(
      A2ASendService,
      A2ASendService.of({
        send: () => Effect.die("send_message is outside this placement-handler test"),
        listParticipants: () =>
          Effect.succeed([
            {
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
            },
          ]),
      }),
    );
    const placementService = Layer.mock(ParticipantPlacementService)({
      listParticipants: () =>
        Effect.succeed([
          {
            squadronId,
            participantId: callerParticipantId,
            participant: {
              kind: "agent" as const,
              id: callerParticipantId,
              threadId: invocation.threadId,
            },
            threadId: invocation.threadId,
            provenance: { kind: "unknown" as const, source: "native_or_unobserved" as const },
            placementParentId: null,
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
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const call = (
        name: "list_participants" | "stop_agent" | "archive_agent",
        args: Record<string, unknown>,
      ) =>
        toolkit
          .handle(name, args)
          .pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext, invocation),
          );

      const listed = yield* call("list_participants", {});
      assert.equal(
        (
          listed.result as unknown as {
            readonly participants: ReadonlyArray<{ provenance: { kind: string } }>;
          }
        ).participants[0]?.provenance.kind,
        "unknown",
      );
      yield* call("stop_agent", {
        client_request_id: "cascade-stop-1",
        squadron_id: squadronId,
        participant_id: childParticipantId,
      });
      yield* call("archive_agent", {
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
    }).pipe(Effect.provide(layer));
  }),
);
