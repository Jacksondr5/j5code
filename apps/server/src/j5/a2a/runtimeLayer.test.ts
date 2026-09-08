import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId } from "@t3tools/contracts";
import { HttpRouter } from "effect/unstable/http";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { layer as outboxLayer } from "../../orchestration-v2/EffectOutbox.ts";
import { A2ADeliveryTransport, live as deliveryTransportLayer } from "./DeliveryTransport.ts";
import { WorkflowService } from "../workflow-definitions/Service.ts";
import { j5AuthenticatedRouteRegistration as j5AuthenticatedRoutesLayer } from "./J5AuthenticatedRoutes.ts";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ThreadLifecycleService } from "../../orchestration-v2/ThreadLifecycleService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ArchiveAgentService } from "./ArchiveAgentService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { A2AArchiveFacts } from "./ArchiveFactsService.ts";
import { A2ALifecycleService } from "./LifecycleService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { ParticipantPlacementService } from "./PlacementService.ts";
import { A2ASilenceDetector } from "./SilenceDetector.ts";
import { ThreadHomesService } from "./ThreadHomesService.ts";
import { SpawnCompositionService } from "./SpawnCompositionService.ts";
import { makeJ5A2ARuntimeLayer } from "./runtimeLayer.ts";

const archiveDependencies = Layer.mergeAll(
  Layer.mock(ServerSecretStore)({
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
  }),
  Layer.mock(ThreadLifecycleService)({
    archive: () => Effect.die("unused archive in runtime topology test"),
  }),
);

const measureNestedRuntimeBuilds = (nested: "http" | "mcp") =>
  Effect.scoped(
    Effect.gen(function* () {
      const databaseContext = yield* Layer.build(NodeSqliteClient.layerMemory());
      const database = Layer.succeed(
        SqlClient.SqlClient,
        Context.get(databaseContext, SqlClient.SqlClient),
      );
      yield* Effect.all([runMigrations(), runJ5A2AMigrations()], {
        concurrency: 1,
        discard: true,
      }).pipe(Effect.provide(database));

      const ledgers = new Set<A2ALedger["Service"]>();
      const countedLedger = ledgerLayer.pipe(
        Layer.tap((context) => Effect.sync(() => ledgers.add(Context.get(context, A2ALedger)))),
      );
      const threadManagement = Layer.mock(ThreadManagementService)({
        streamStoredEventsFrom: () => Stream.never,
      });
      const runtime = makeJ5A2ARuntimeLayer({ ledger: countedLedger });
      const httpConsumer = Layer.effectDiscard(A2ALedger.pipe(Effect.asVoid));
      const mcpConsumer = Layer.effectDiscard(A2ASilenceDetector.pipe(Effect.asVoid));
      yield* Layer.build(
        Layer.mergeAll(
          nested === "http" ? httpConsumer.pipe(Layer.provide(Layer.fresh(runtime))) : httpConsumer,
          nested === "mcp" ? mcpConsumer.pipe(Layer.provide(Layer.fresh(runtime))) : mcpConsumer,
        ).pipe(
          Layer.provide(runtime),
          Layer.provide(threadManagement),
          Layer.provide(Layer.mock(OrchestratorV2)({})),
          Layer.provide(Layer.mock(EffectOutboxV2)({ listByCommandId: () => Effect.succeed([]) })),
          Layer.provide(archiveDependencies),
          Layer.provide(database),
        ),
      );
      return ledgers.size;
    }),
  );

it.effect("shares one runtime and outbox across the production HTTP and MCP registrations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const databaseContext = yield* Layer.build(NodeSqliteClient.layerMemory());
      const database = Layer.succeed(
        SqlClient.SqlClient,
        Context.get(databaseContext, SqlClient.SqlClient),
      );
      yield* Effect.all([runMigrations(), runJ5A2AMigrations()], {
        concurrency: 1,
        discard: true,
      }).pipe(Effect.provide(database));

      const ledgers = new Set<A2ALedger["Service"]>();
      let threadManagementBuilds = 0;
      const transports = new Set<A2ADeliveryTransport["Service"]>();
      const outboxes = new Set<EffectOutboxV2["Service"]>();
      const countedLedger = ledgerLayer.pipe(
        Layer.tap((context) => Effect.sync(() => ledgers.add(Context.get(context, A2ALedger)))),
      );
      const countedThreadManagement = Layer.mock(ThreadManagementService)({
        streamStoredEventsFrom: () => Stream.never,
      }).pipe(Layer.tap(() => Effect.sync(() => (threadManagementBuilds += 1))));
      const ledgerConsumer = Layer.effectDiscard(A2ALedger.pipe(Effect.asVoid));
      const secondThreadConsumer = Layer.effectDiscard(ThreadManagementService.pipe(Effect.asVoid));
      const placementConsumer = Layer.effectDiscard(
        ParticipantPlacementService.pipe(Effect.asVoid),
      );
      const silenceConsumer = Layer.effectDiscard(A2ASilenceDetector.pipe(Effect.asVoid));
      const lifecycleConsumer = Layer.effectDiscard(A2ALifecycleService.pipe(Effect.asVoid));
      const archiveFactsConsumer = Layer.effectDiscard(A2AArchiveFacts.pipe(Effect.asVoid));
      const archiveAgentConsumer = Layer.effectDiscard(ArchiveAgentService.pipe(Effect.asVoid));
      const threadHomesConsumer = Layer.effectDiscard(ThreadHomesService.pipe(Effect.asVoid));
      const spawnCompositionConsumer = Layer.effectDiscard(
        SpawnCompositionService.pipe(Effect.asVoid),
      );
      const runtime = makeJ5A2ARuntimeLayer({
        ledger: countedLedger,
        deliveryTransport: deliveryTransportLayer.pipe(
          Layer.tap((context) =>
            Effect.sync(() => transports.add(Context.get(context, A2ADeliveryTransport))),
          ),
        ),
      });
      yield* Layer.build(
        HttpRouter.serve(
          Layer.mergeAll(
            j5AuthenticatedRoutesLayer.pipe(
              Layer.provide(Layer.mock(WorkflowService)({ definitions: [] })),
            ),
            McpHttpServer.layer,
            ledgerConsumer,
            secondThreadConsumer,
            placementConsumer,
            silenceConsumer,
            lifecycleConsumer,
            archiveFactsConsumer,
            archiveAgentConsumer,
            threadHomesConsumer,
            spawnCompositionConsumer,
          ).pipe(
            Layer.provideMerge(runtime),
            Layer.provide(countedThreadManagement),
            Layer.provide(Layer.mock(OrchestratorV2)({})),
            Layer.provide(
              outboxLayer.pipe(
                Layer.tap((context) =>
                  Effect.sync(() => outboxes.add(Context.get(context, EffectOutboxV2))),
                ),
              ),
            ),
            Layer.provide(McpSessionRegistry.layer),
            Layer.provide(PreviewAutomationBroker.layer),
            Layer.provide(
              Layer.mock(ServerEnvironment)({
                getEnvironmentId: Effect.succeed(
                  EnvironmentId.make("environment:runtime-composition"),
                ),
              }),
            ),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(EnvironmentAuth)({}),
                Layer.mock(ProjectService)({}),
                Layer.mock(ProjectSetupScriptRunner)({}),
                Layer.mock(ProviderRegistry)({}),
                Layer.mock(ScheduledTaskService)({}),
                Layer.mock(GitWorkflowService)({}),
                Layer.mock(VcsStatusBroadcaster)({}),
                ServerSettingsService.layerTest(),
              ),
            ),
            Layer.provide(archiveDependencies),
            Layer.provide(database),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(
          Layer.provide(Layer.mock(EnvironmentAuth)({})),
          Layer.provide(NodeHttpServer.layerTest),
          Layer.provide(NodeServices.layer),
        ),
      );

      assert.equal(ledgers.size, 1);
      assert.equal(threadManagementBuilds, 1);
      assert.equal(transports.size, 1);
      assert.equal(outboxes.size, 1);
      const sql = Context.get(databaseContext, SqlClient.SqlClient);
      const people = yield* sql<{
        readonly is_local_operator: number;
        readonly person_id: string;
      }>`
        SELECT person_id, is_local_operator
        FROM j5_a2a_human_person
      `;
      assert.lengthOf(people, 1);
      assert.match(people[0]!.person_id, /^human:[0-9a-f]{8}-[0-9a-f-]{27}$/);
      assert.equal(people[0]!.is_local_operator, 1);
      const domainCounts = yield* sql<{
        readonly events: number;
        readonly memberships: number;
        readonly squadrons: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM j5_a2a_squadron) AS squadrons,
          (SELECT COUNT(*) FROM j5_a2a_squadron_membership) AS memberships,
          (SELECT COUNT(*) FROM j5_a2a_comm_event) AS events
      `;
      assert.deepStrictEqual(domainCounts, [{ squadrons: 0, memberships: 0, events: 0 }]);
    }),
  ),
);

it.effect("detects a fresh nested HTTP or MCP runtime as a distinct ledger instance", () =>
  Effect.gen(function* () {
    assert.equal(yield* measureNestedRuntimeBuilds("http"), 2);
    assert.equal(yield* measureNestedRuntimeBuilds("mcp"), 2);
  }),
);
