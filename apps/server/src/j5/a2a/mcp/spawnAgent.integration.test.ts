import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, NodeId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import { A2ADeliveryWorker } from "../DeliveryWorker.ts";
import {
  A2AHomeRegistrar,
  participantIdForThread,
  layer as homeRegistrarLayer,
} from "../HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "../LedgerService.ts";
import { runJ5A2AMigrations } from "../Migrations.ts";
import { PlacementCascadeService } from "../PlacementCascadeService.ts";
import {
  ParticipantPlacementService,
  layer as participantPlacementLayer,
} from "../PlacementService.ts";
import { A2ASendService, layer as sendServiceLayer } from "../SendService.ts";
import { CommCommandId, SquadronId } from "../contracts.ts";
import { PlacementCommandId } from "../placementContracts.ts";
import { J5ToolkitHandlersLive } from "./handlers.ts";
import { J5Toolkit, type J5SpawnAgentInput } from "./tools.ts";

const createdAt = "2026-08-27T21:00:00.000Z";
const squadronId = SquadronId.make("squadron:j5:spawn-integration");
const parentThreadId = ThreadId.make("thread:j5:spawn-integration-parent");
const childThreadId = ThreadId.make("thread:j5:spawn-integration-child");
const parentParticipantId = participantIdForThread(parentThreadId);
const childParticipantId = participantIdForThread(childThreadId);

const invocation = {
  environmentId: EnvironmentId.make("environment:j5:spawn-integration"),
  threadId: parentThreadId,
  providerSessionId: "provider-session:j5:spawn-integration",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};

it.effect(
  "persists one registrar home and fixed-spawner placement through the production handler",
  () =>
    Effect.gen(function* () {
      const database = NodeSqliteClient.layerMemory();
      const ledger = ledgerLayer.pipe(Layer.provide(database));
      const registrar = homeRegistrarLayer.pipe(Layer.provide(ledger), Layer.provide(database));
      const placements = participantPlacementLayer.pipe(Layer.provide(database));
      const send = sendServiceLayer.pipe(Layer.provide(ledger), Layer.provide(database));
      const realServices = Layer.mergeAll(database, ledger, registrar, placements, send);
      const taskId = NodeId.make("node:j5:spawn-integration-task");
      const delegation = {
        taskId,
        childThreadId,
        childRunId: null,
        childNodeId: NodeId.make("node:j5:spawn-integration-child"),
        status: "waiting" as const,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-fable-5",
        summary: null,
        resultContextTransferId: null,
        waitTimedOut: false,
      };
      const upstream = Layer.mock(OrchestratorMcpService)({
        delegateTask: () => Effect.succeed(delegation),
      });
      const threads = Layer.mock(ThreadManagementService)({
        getThreadProjection: (threadId) =>
          Effect.succeed({
            thread: {
              createdAt,
              lineage:
                threadId === parentThreadId
                  ? { parentThreadId: null, relationshipToParent: null }
                  : { parentThreadId, relationshipToParent: "subagent" },
            },
          } as never),
      });
      const dependencies = Layer.mergeAll(
        realServices,
        upstream,
        threads,
        Layer.mock(PlacementCascadeService)({}),
        Layer.mock(A2ADeliveryWorker)({ notify: Effect.void }),
        NodeServices.layer,
      );
      const handlerLayer = J5ToolkitHandlersLive.pipe(Layer.provideMerge(dependencies));

      yield* Effect.gen(function* () {
        yield* runJ5A2AMigrations();
        const ledgerService = yield* A2ALedger;
        yield* ledgerService.createSquadron({
          squadron: { id: squadronId, name: "Spawn integration", createdAt },
        });
        yield* (yield* A2AHomeRegistrar).registerAtCreation({
          commandId: CommCommandId.make("command:j5:spawn-integration:parent-home"),
          squadronId,
          threadId: parentThreadId,
          createdAt,
        });
        yield* (yield* ParticipantPlacementService).recordCreation({
          commandId: PlacementCommandId.make("command:j5:spawn-integration:parent-placement"),
          squadronId,
          participantId: parentParticipantId,
          actor: "platform",
          provenance: { kind: "unknown", source: "native_or_unobserved" },
          createdAt,
        });

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
        const callList = () =>
          toolkit
            .handle("list_participants", {})
            .pipe(
              Stream.unwrap,
              Stream.run(Sink.last()),
              Effect.flatMap(Effect.fromOption),
              Effect.provideService(McpInvocationContext, invocation),
            );
        const spawnInput = {
          task: "Run the isolated Claude receiver",
          target: { providerInstanceId: ProviderInstanceId.make("claudeAgent") },
          mode: "async" as const,
          clientRequestId: "spawn-integration-replay-1",
        } satisfies J5SpawnAgentInput;

        const first = yield* callSpawn(spawnInput);
        const replay = yield* callSpawn(spawnInput);
        assert.isFalse(first.isFailure);
        assert.isFalse(replay.isFailure);
        assert.deepStrictEqual(yield* (yield* A2AHomeRegistrar).getHomeForThread(childThreadId), {
          squadronId,
          participantId: childParticipantId,
        });
        const childPlacement = yield* (yield* ParticipantPlacementService).readPlacement({
          squadronId,
          participantId: childParticipantId,
        });
        assert.deepStrictEqual(childPlacement?.provenance, {
          kind: "spawned-by",
          spawnedByParticipantId: parentParticipantId,
          source: "j5_wrapper",
        });
        assert.equal(childPlacement?.placementParentId, parentParticipantId);

        const listed = yield* callList();
        const listedRows = (
          listed.result as unknown as {
            readonly participants: ReadonlyArray<{
              readonly participantId: string;
              readonly provenance: {
                readonly kind: string;
                readonly source?: string;
                readonly spawnedByParticipantId?: string;
              };
              readonly placementParentId: string | null;
            }>;
          }
        ).participants;
        const listedChild = listedRows.find((row) => row.participantId === childParticipantId);
        assert.deepStrictEqual(listedChild?.provenance, {
          kind: "spawned-by",
          spawnedByParticipantId: parentParticipantId,
          source: "j5_wrapper",
        });
        assert.equal(listedChild?.placementParentId, parentParticipantId);

        const sql = yield* SqlClient.SqlClient;
        const counts = yield* sql<{
          readonly joined: number;
          readonly placement_events: number;
        }>`
        SELECT
          (SELECT COUNT(*) FROM j5_a2a_comm_event
            WHERE kind = 'participant.joined'
              AND json_extract(payload, '$.participant.threadId') = ${childThreadId}) AS joined,
          (SELECT COUNT(*) FROM j5_a2a_placement_event
            WHERE participant_id = ${childParticipantId}) AS placement_events
      `;
        assert.deepStrictEqual(counts, [{ joined: 1, placement_events: 1 }]);
      }).pipe(Effect.provide(handlerLayer));
    }),
);
