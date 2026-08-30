import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { ParticipantPlacementService } from "./PlacementService.ts";
import { A2ASilenceDetector } from "./SilenceDetector.ts";
import { makeJ5A2ARuntimeLayer } from "./runtimeLayer.ts";

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

      let ledgerBuilds = 0;
      const countedLedger = ledgerLayer.pipe(
        Layer.tap(() => Effect.sync(() => (ledgerBuilds += 1))),
      );
      const threadManagement = Layer.mock(ThreadManagementService)({
        streamStoredEventsFrom: () => Stream.never,
      });
      const runtime = makeJ5A2ARuntimeLayer({ ledger: countedLedger });
      const httpConsumer = Layer.effectDiscard(A2ALedger.pipe(Effect.asVoid));
      const mcpConsumer = Layer.effectDiscard(A2ASilenceDetector.pipe(Effect.asVoid));
      yield* Layer.build(
        Layer.mergeAll(
          nested === "http" ? httpConsumer.pipe(Layer.provide(runtime)) : httpConsumer,
          nested === "mcp" ? mcpConsumer.pipe(Layer.provide(runtime)) : mcpConsumer,
        ).pipe(Layer.provide(runtime), Layer.provide(threadManagement), Layer.provide(database)),
      );
      return ledgerBuilds;
    }),
  );

it.effect("shares one runtime across the combined HTTP and MCP-style route graph", () =>
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

      let ledgerBuilds = 0;
      let threadManagementBuilds = 0;
      const countedLedger = ledgerLayer.pipe(
        Layer.tap(() => Effect.sync(() => (ledgerBuilds += 1))),
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
      const runtime = makeJ5A2ARuntimeLayer({ ledger: countedLedger });
      yield* Layer.build(
        Layer.mergeAll(
          ledgerConsumer,
          secondThreadConsumer,
          placementConsumer,
          silenceConsumer,
        ).pipe(
          Layer.provideMerge(runtime),
          Layer.provide(countedThreadManagement),
          Layer.provide(database),
        ),
      );

      assert.equal(ledgerBuilds, 1);
      assert.equal(threadManagementBuilds, 1);
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

it.effect("exposes either nested route provider as a second runtime build", () =>
  Effect.gen(function* () {
    assert.equal(yield* measureNestedRuntimeBuilds("http"), 2);
    assert.equal(yield* measureNestedRuntimeBuilds("mcp"), 2);
  }),
);
