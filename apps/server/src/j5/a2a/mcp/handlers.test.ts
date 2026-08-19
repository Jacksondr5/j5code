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
import { A2ASendService } from "../SendService.ts";
import { LedgerMessageId, ParticipantId, type SendMessageInput } from "../contracts.ts";
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
      "list_participants",
      "send_message",
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
