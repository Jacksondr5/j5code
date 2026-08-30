import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { A2AHomeRegistrar, layer as homeRegistrarLayer } from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { ThreadHomesService, layer as threadHomesServiceLayer } from "./ThreadHomesService.ts";
import { CommCommandId, SquadronId } from "./contracts.ts";

const createdAt = "2026-08-29T22:00:00.000Z";

const makeTestLayer = () => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const registrar = homeRegistrarLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const threadHomes = threadHomesServiceLayer.pipe(Layer.provide(registrar), Layer.provide(ledger));
  return Layer.mergeAll(database, ledger, registrar, threadHomes);
};

it.effect(
  "returns distinct immutable Registrar homes for same-folder Squadrons without a project proxy",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const ledger = yield* A2ALedger;
      const registrar = yield* A2AHomeRegistrar;
      const reads = yield* ThreadHomesService;
      const sql = yield* SqlClient.SqlClient;
      const alphaSquadron = SquadronId.make("squadron:thread-homes:alpha");
      const betaSquadron = SquadronId.make("squadron:thread-homes:beta");
      const alphaThread = ThreadId.make("thread:thread-homes:alpha");
      const betaThread = ThreadId.make("thread:thread-homes:beta");
      const nativeThread = ThreadId.make("thread:thread-homes:native");

      yield* ledger.createSquadron({
        squadron: { id: alphaSquadron, name: "Alpha Squadron", createdAt },
      });
      yield* ledger.createSquadron({
        squadron: { id: betaSquadron, name: "Beta Squadron", createdAt },
      });
      yield* sql`
        INSERT INTO j5_a2a_squadron_project_reference (
          squadron_id, project_id, ordinal, created_at
        ) VALUES
          (${alphaSquadron}, 'project:shared-folder', 0, ${createdAt}),
          (${betaSquadron}, 'project:shared-folder', 0, ${createdAt})
      `;
      yield* registrar.registerAtCreation({
        squadronId: alphaSquadron,
        threadId: alphaThread,
        createdAt,
        commandId: CommCommandId.make("command:thread-homes:alpha"),
      });
      yield* registrar.registerAtCreation({
        squadronId: betaSquadron,
        threadId: betaThread,
        createdAt,
        commandId: CommCommandId.make("command:thread-homes:beta"),
      });

      const result = yield* reads.threadHomes([betaThread, nativeThread, alphaThread, betaThread]);
      assert.deepStrictEqual(result, {
        entries: [
          {
            threadId: betaThread,
            home: { kind: "known", squadron: { id: betaSquadron, name: "Beta Squadron" } },
          },
          { threadId: nativeThread, home: { kind: "unknown" } },
          {
            threadId: alphaThread,
            home: { kind: "known", squadron: { id: alphaSquadron, name: "Alpha Squadron" } },
          },
        ],
      });
      assert.deepStrictEqual(yield* reads.threadHomes([]), { entries: [] });
    }).pipe(Effect.provide(makeTestLayer())),
);
