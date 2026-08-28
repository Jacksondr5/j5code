import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import { A2AHomeRegistrar, participantIdForThread } from "../HomeRegistrar.ts";
import { A2ALedger } from "../LedgerService.ts";
import { PlacementCascadeService } from "../PlacementCascadeService.ts";
import { ParticipantPlacementService } from "../PlacementService.ts";
import { A2ASendService } from "../SendService.ts";
import { SquadronId } from "../contracts.ts";
import { J5ToolkitRegistrationLive } from "./registration.ts";

const createdAt = "2026-08-28T14:00:00.000Z";
const squadronId = SquadronId.make("squadron:j5:registration-resolution");
const parentThreadId = ThreadId.make("thread:j5:registration-resolution-parent");
const parentParticipantId = participantIdForThread(parentThreadId);
const invocation = {
  environmentId: EnvironmentId.make("environment:j5:registration-resolution"),
  threadId: parentThreadId,
  providerSessionId: "provider-session:j5:registration-resolution",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};

it.effect("resolves the real orchestrator service through the J5 MCP registration", () =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      Layer.mock(A2ASendService)({
        listParticipants: () =>
          Effect.succeed([
            {
              squadronId,
              participantId: parentParticipantId,
              participant: {
                kind: "agent" as const,
                id: parentParticipantId,
                threadId: parentThreadId,
              },
              canReceiveMessage: true,
              canOpenExchange: true,
              acceptsUrgency: false,
            },
          ]),
      }),
      Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
      Layer.mock(A2ALedger)({
        readSquadron: () =>
          Effect.succeed({ id: squadronId, name: "Registration resolution", createdAt }),
      }),
      Layer.mock(A2AHomeRegistrar)({}),
      Layer.mock(ParticipantPlacementService)({
        readPlacement: () =>
          Effect.succeed({
            squadronId,
            participantId: parentParticipantId,
            provenance: { kind: "unknown", source: "native_or_unobserved" },
            placementParentId: null,
            createdEventSeq: 1,
            updatedEventSeq: 1,
          }),
      }),
      Layer.mock(PlacementCascadeService)({}),
      Layer.mock(ThreadManagementService)({
        getThreadProjection: () =>
          Effect.succeed({
            thread: {},
            runs: [],
          } as never),
      }),
      Layer.mock(ProviderRegistry)({}),
      Layer.mock(ScheduledTaskService)({}),
      NodeServices.layer,
    );
    const registration = J5ToolkitRegistrationLive.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(dependencies),
    );
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      protocolVersion: "2025-06-18",
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "j5-registration-test", version: "1.0.0" },
      },
      getClient: Effect.die("unused"),
    });

    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "spawn_agent",
          arguments: {
            task: "Prove the production registration resolves its orchestrator dependency",
            target: { providerInstanceId: ProviderInstanceId.make("claudeAgent") },
            mode: "async",
            clientRequestId: "spawn-registration-resolution-1",
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      assert.isFalse(result.isError);
      const text = result.content.find((item) => item.type === "text");
      assert.equal(text?.type, "text");
      if (text?.type === "text") {
        assert.include(
          text.text,
          "Delegated tasks require an active run owned by this MCP provider session.",
        );
      }
    }).pipe(Effect.provide(registration));
  }),
);
