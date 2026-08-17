import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ThreadLifecycleService } from "../../orchestration-v2/ThreadLifecycleService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ASilenceDetector } from "./SilenceDetector.ts";
import { makeJ5A2ARuntimeLayer } from "./runtimeLayer.ts";

it.effect("shares one ledger and thread-management instance across the runtime graph", () =>
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
      let threadLifecycleBuilds = 0;
      let threadManagementBuilds = 0;
      const countedLedger = ledgerLayer.pipe(
        Layer.tap(() => Effect.sync(() => (ledgerBuilds += 1))),
      );
      const countedThreadManagement = Layer.mock(ThreadManagementService)({
        streamStoredEventsFrom: () => Stream.never,
      }).pipe(Layer.tap(() => Effect.sync(() => (threadManagementBuilds += 1))));
      const countedThreadLifecycle = Layer.mock(ThreadLifecycleService)({}).pipe(
        Layer.tap(() => Effect.sync(() => (threadLifecycleBuilds += 1))),
      );
      const secondThreadConsumer = Layer.effectDiscard(ThreadManagementService.pipe(Effect.asVoid));
      const secondLifecycleConsumer = Layer.effectDiscard(
        ThreadLifecycleService.pipe(Effect.asVoid),
      );
      const silenceConsumer = Layer.effectDiscard(A2ASilenceDetector.pipe(Effect.asVoid));
      const runtime = makeJ5A2ARuntimeLayer({ ledger: countedLedger });
      yield* Layer.build(
        Layer.mergeAll(secondThreadConsumer, secondLifecycleConsumer, silenceConsumer).pipe(
          Layer.provideMerge(runtime),
          Layer.provide(countedThreadLifecycle),
          Layer.provide(countedThreadManagement),
          Layer.provide(database),
        ),
      );

      assert.equal(ledgerBuilds, 1);
      assert.equal(threadLifecycleBuilds, 1);
      assert.equal(threadManagementBuilds, 1);
    }),
  ),
);
