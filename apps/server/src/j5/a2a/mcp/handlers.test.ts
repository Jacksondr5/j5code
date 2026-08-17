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
import { A2AEpicBootstrap } from "../EpicBootstrapService.ts";
import { A2ASendService } from "../SendService.ts";
import { EpicId, LedgerMessageId, ParticipantId, type SendMessageInput } from "../contracts.ts";
import { J5ToolkitHandlersLive } from "./handlers.ts";
import { J5Toolkit } from "./tools.ts";

const invocation = {
  environmentId: EnvironmentId.make("environment:j5:mcp-handler"),
  threadId: ThreadId.make("thread:j5:mcp-handler"),
  providerSessionId: "provider-session:j5:mcp-handler",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};

it.effect("derives send idempotency and epic bootstrap identity from authenticated scope", () =>
  Effect.gen(function* () {
    const sends = yield* Ref.make<ReadonlyArray<SendMessageInput>>([]);
    const bootstrapThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const epicId = EpicId.make("epic:j5:mcp-handler");
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
    const bootstrapService = Layer.succeed(
      A2AEpicBootstrap,
      A2AEpicBootstrap.of({
        joinEpic: (input) =>
          Ref.update(bootstrapThreads, (threads) => [...threads, input.senderThreadId]).pipe(
            Effect.as({
              epicId: input.epicId ?? epicId,
              participantId,
              state: "selected" as const,
              previousEpicIds: [],
              openExchangeWarnings: [],
            }),
          ),
      }),
    );
    const dependencies = Layer.mergeAll(
      sendService,
      bootstrapService,
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      NodeServices.layer,
    );
    const layer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

    yield* Effect.gen(function* () {
      const toolkit = yield* J5Toolkit;
      const call = (name: "send_message" | "join_epic", args: Record<string, unknown>) =>
        toolkit
          .handle(name, args)
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
      yield* call("send_message", sendArguments);
      yield* call("send_message", sendArguments);
      const captured = yield* Ref.get(sends);
      assert.lengthOf(captured, 2);
      assert.equal(captured[0]?.commandId, captured[1]?.commandId);
      assert.equal(captured[0]?.senderThreadId, invocation.threadId);

      yield* call("join_epic", { epic_id: epicId });
      assert.deepStrictEqual(yield* Ref.get(bootstrapThreads), [invocation.threadId]);
    }).pipe(Effect.provide(layer));
  }),
);
